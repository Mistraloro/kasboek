//! Transfers between the person's own accounts: money out of one and into another a few days apart. Paired, both halves
//! sit in a transfer category, so they count as neither income nor spending. Between currencies the difference is the
//! exchange cost, booked as a split of the outgoing half (src/core/transfers.ts).
use crate::core::Core;
use crate::dates::{day_diff, js_round};
use crate::error::{AppError, AppResult};
use crate::finance::{list_splits, norm_iban, set_splits, SplitPart};
use kb_db::rows::TransferCandidate;
use kb_db::Store;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashSet;

/// Between currencies, without a known bank cost: what arrives may be up to 7% below the amount at the day's rate (bank
/// margins, fees) and 1% above it (a rate a day earlier or later).
const LOW: f64 = 0.93;
const HIGH: f64 = 1.01;
/// With a known bank cost: what arrives may differ this much (as a share) from what is expected.
const SPREAD: f64 = 0.015;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferPair {
    pub out_id: i64,
    pub in_id: i64,
    pub date: String,
    pub amount_cents: i64,
    pub currency: String,
    pub in_amount_cents: i64,
    pub in_currency: String,
    pub cost_cents: Option<i64>,
    pub from_account: String,
    pub to_account: String,
    pub confidence: &'static str,
    pub days: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCostInfo {
    pub cross: bool,
    pub currency: Option<String>,
    pub cost_cents: Option<i64>,
}

/// The exchange cost of money moved between currencies, in the outgoing account's currency: what the amount was worth at
/// the day's rate minus what arrived. With no rate, the bank's percentage (if known). Never negative.
#[allow(clippy::too_many_arguments)]
pub fn exchange_cost<S: Store>(
    store: &S,
    out_cents: i64,
    out_currency: &str,
    in_cents: i64,
    in_currency: &str,
    date: &str,
    cost_pct: Option<f64>,
) -> AppResult<Option<i64>> {
    let sent = -out_cents as f64;
    if let Some(worth) = store.fx_convert(sent, out_currency, date, in_currency)? {
        let lost_in = worth - in_cents as f64;
        return Ok(store.fx_convert(lost_in, in_currency, date, out_currency)?.map(|lost| js_round(lost).max(0.0) as i64));
    }
    Ok(cost_pct.map(|pct| js_round(sent * pct / 100.0) as i64))
}

/// How closely the arriving amount fits the outgoing one; `None` when they can't be a transfer. Lower is closer.
fn fit<S: Store>(store: &S, r: &TransferCandidate, sure: bool) -> AppResult<Option<f64>> {
    if r.o_currency == r.i_currency {
        return Ok((r.i_amount == -r.o_amount).then_some(0.0));
    }
    if r.i_amount <= 0 {
        return Ok(None);
    }
    let worth = store.fx_convert(-r.o_amount as f64, &r.o_currency, &r.o_date, &r.i_currency)?;
    // Without a rate the amounts can't be compared: only the account number can tell.
    let Some(worth) = worth.filter(|w| *w > 0.0) else { return Ok(sure.then_some(1.0)) };
    let ratio = r.i_amount as f64 / worth;
    if let Some(pct) = r.o_cost_pct {
        let expected = 1.0 - pct / 100.0;
        return Ok(((ratio - expected).abs() <= SPREAD).then(|| (ratio - expected).abs()));
    }
    Ok((LOW..=HIGH).contains(&ratio).then(|| (1.0 - ratio).abs()))
}

#[derive(Clone)]
struct Scored<'a> {
    r: &'a TransferCandidate,
    sure: bool,
    days: f64,
    closeness: f64,
}

/// `a || b || c ...` over numeric differences: the first one that is neither 0 nor NaN decides.
fn by_first_difference(diffs: [f64; 4]) -> Ordering {
    diffs
        .into_iter()
        .find(|d| *d != 0.0 && !d.is_nan())
        .map_or(Ordering::Equal, |d| if d < 0.0 { Ordering::Less } else { Ordering::Greater })
}

/// A stable merge sort that never panics on an inconsistent comparison (a date that does not read gives NaN days).
fn stable_sort<T: Clone>(items: Vec<T>, cmp: &impl Fn(&T, &T) -> Ordering) -> Vec<T> {
    if items.len() <= 1 {
        return items;
    }
    let mid = items.len() / 2;
    let (left, right) = (stable_sort(items[..mid].to_vec(), cmp), stable_sort(items[mid..].to_vec(), cmp));
    let mut out = Vec::with_capacity(items.len());
    let (mut l, mut r) = (0, 0);
    while l < left.len() && r < right.len() {
        if cmp(&right[r], &left[l]) == Ordering::Less {
            out.push(right[r].clone());
            r += 1;
        } else {
            out.push(left[l].clone());
            l += 1;
        }
    }
    out.extend_from_slice(&left[l..]);
    out.extend_from_slice(&right[r..]);
    out
}

/// Unpaired transfers, the surest first; each transaction is in at most one pair.
pub fn find_transfers<S: Store>(store: &S) -> AppResult<Vec<TransferPair>> {
    find_transfers_of(store, None)
}

/// Like `find_transfers`, limited to pairs with one of these transactions (`onlyIds`: the ones an import just added).
pub fn find_transfers_of<S: Store>(store: &S, only_ids: Option<&[i64]>) -> AppResult<Vec<TransferPair>> {
    let rows = store.transfer_candidates()?;
    let only: Option<HashSet<i64>> = only_ids.map(|ids| ids.iter().copied().collect());
    let mut scored = Vec::new();
    for r in rows.iter().filter(|r| only.as_ref().is_none_or(|ids| ids.contains(&r.oid) || ids.contains(&r.iid))) {
        // Sure when one side names the other account's number.
        let named = |cp: &Option<String>, acc: &Option<String>| {
            cp.as_deref().is_some_and(|c| !c.is_empty())
                && acc.as_deref().is_some_and(|a| !a.is_empty())
                && norm_iban(cp.as_deref()) == norm_iban(acc.as_deref())
        };
        let sure = named(&r.o_cp_iban, &r.i_acc_iban) || named(&r.i_cp_iban, &r.o_acc_iban);
        let Some(closeness) = fit(store, r, sure)? else { continue };
        scored.push(Scored { r, sure, days: day_diff(&r.o_date, &r.i_date).abs(), closeness });
    }
    let scored = stable_sort(scored, &|a: &Scored<'_>, b: &Scored<'_>| {
        by_first_difference([
            f64::from(u8::from(b.sure)) - f64::from(u8::from(a.sure)),
            a.closeness - b.closeness,
            a.days - b.days,
            (a.r.oid - b.r.oid) as f64,
        ])
    });
    let mut used = HashSet::new();
    let mut out = Vec::new();
    for Scored { r, sure, days, .. } in scored {
        if used.contains(&r.oid) || used.contains(&r.iid) {
            continue;
        }
        used.insert(r.oid);
        used.insert(r.iid);
        let cross = r.o_currency != r.i_currency;
        out.push(TransferPair {
            out_id: r.oid,
            in_id: r.iid,
            date: r.o_date.clone(),
            amount_cents: -r.o_amount,
            currency: r.o_currency.clone(),
            in_amount_cents: r.i_amount,
            in_currency: r.i_currency.clone(),
            cost_cents: if cross {
                exchange_cost(store, r.o_amount, &r.o_currency, r.i_amount, &r.i_currency, &r.o_date, r.o_cost_pct)?
            } else {
                None
            },
            from_account: r.o_name.clone(),
            to_account: r.i_name.clone(),
            confidence: if sure { "iban" } else { "amount" },
            days,
        });
    }
    Ok(out)
}

/// The transfer category for a pair: one of the halves already has, else the first one.
fn transfer_category<S: Store>(store: &S, ids: &[i64]) -> AppResult<Option<i64>> {
    match store.transfer_category_of(ids)? {
        Some(id) => Ok(Some(id)),
        None => Ok(store.first_transfer_category()?),
    }
}

/// The starting "Fees & taxes" category in each language Kasboek has.
const FEE_NAMES: [&str; 7] = [
    "fees & taxes",
    "kosten en belastingen",
    "frais et impôts",
    "gebühren und steuern",
    "comisiones e impuestos",
    "comissões e impostos",
    "tarifas e impostos",
];
const FEE_WORDS: [&str; 9] = ["fee", "cost", "kost", "frais", "gebühr", "comisi", "comiss", "tarifa", "bank"];

/// Where exchange costs go: the fees category (by its starting name), else any expense category about costs or fees.
pub fn cost_category<S: Store>(store: &S) -> AppResult<Option<i64>> {
    let cats = store.expense_categories()?;
    let by_name = cats.iter().find(|(_, n)| FEE_NAMES.contains(&n.to_lowercase().as_str()));
    let by_word = || cats.iter().find(|(_, n)| FEE_WORDS.iter().any(|w| n.to_lowercase().contains(w)));
    Ok(by_name.or_else(by_word).map(|(id, _)| *id))
}

/// Whether a transaction's split is the transfer-plus-exchange-cost one Kasboek made.
fn is_cost_split<S: Store>(store: &S, id: i64) -> AppResult<bool> {
    let parts = list_splits(store, id)?;
    if parts.len() != 2 {
        return Ok(false);
    }
    for p in &parts {
        if let Some(cat) = p.category_id {
            if store.category_kind(cat)?.as_deref() == Some("transfer") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Books the exchange cost of a pair between currencies: the outgoing half becomes the transfer plus the cost. 0 removes
/// the cost again. Without a fees category, or for a pair in one currency, nothing is booked.
fn book_cost<S: Store>(store: &S, out_id: i64, cost_cents: i64) -> AppResult<()> {
    let Some(o) = store.pair_tx_get(out_id)?.filter(|o| o.transfer_pair.as_deref().is_some_and(|p| !p.is_empty())) else { return Ok(()) };
    let cat = transfer_category(store, &[out_id])?;
    let fees = cost_category(store)?;
    let cost = cost_cents.max(0).min(-o.amount_cents - 1);
    let (Some(cat), Some(fees), true) = (cat, fees, cost != 0) else {
        if is_cost_split(store, out_id)? {
            set_splits(store, out_id, &[])?;
        }
        return Ok(());
    };
    set_splits(
        store,
        out_id,
        &[
            SplitPart { category_id: Some(cat), amount_cents: o.amount_cents + cost, note: None },
            SplitPart { category_id: Some(fees), amount_cents: -cost, note: Some("Exchange cost".into()) },
        ],
    )?;
    Ok(())
}

pub struct PairRequest {
    pub out_id: i64,
    pub in_id: i64,
    pub cost_cents: Option<i64>,
}

fn paired(pair: &Option<String>) -> bool {
    pair.as_deref().is_some_and(|p| !p.is_empty())
}

/// Pairs transfers; between currencies the exchange cost (given, or worked out from the rate) is booked on the sending half.
pub fn pair_transfers<S: Store>(core: &Core<S>, pairs: &[PairRequest]) -> AppResult<u64> {
    core.db()?.transaction::<_, AppError, _>(|db| {
        let mut count = 0;
        for p in pairs {
            let (Some(o), Some(i)) = (db.pair_tx_get(p.out_id)?, db.pair_tx_get(p.in_id)?) else {
                return Err(AppError::new("tx.not_found", "That transaction no longer exists."));
            };
            let cross = o.currency != i.currency;
            if o.account_id == i.account_id || o.amount_cents >= 0 || i.amount_cents <= 0 || (!cross && o.amount_cents != -i.amount_cents) {
                return Err(AppError::new(
                    "transfers.mismatch",
                    "A transfer needs money out of one account and the same amount (or, in another currency, its value) into another.",
                ));
            }
            if paired(&o.transfer_pair) || paired(&i.transfer_pair) {
                continue;
            }
            let key = format!("{:016x}", core.rng.next_u64());
            let cat = transfer_category(db, &[o.id, i.id])?;
            db.pair_set(o.id, &key, cat)?;
            db.pair_set(i.id, &key, cat)?;
            if cross {
                let cost = match p.cost_cents {
                    Some(c) => Some(c),
                    None => exchange_cost(db, o.amount_cents, &o.currency, i.amount_cents, &i.currency, &o.booking_date, o.fx_cost_pct)?,
                };
                if let Some(cost) = cost.filter(|c| *c != 0) {
                    book_cost(db, o.id, cost)?;
                }
            }
            count += 1;
        }
        Ok(count)
    })
}

/// The pair key of a transaction, `None` when it is not paired (or does not exist).
fn pair_of<S: Store>(store: &S, id: i64) -> AppResult<Option<String>> {
    Ok(store.tx_transfer_pair(id)?.flatten().filter(|p| !p.is_empty()))
}

/// Changes the exchange cost of a pair between currencies, in the outgoing account's currency. Either half's id will do.
pub fn set_transfer_cost<S: Store>(store: &S, id: i64, cost_cents: i64) -> AppResult<i64> {
    let pair = pair_of(store, id)?.ok_or_else(|| AppError::new("transfers.not_paired", "This transaction isn’t paired as a transfer."))?;
    let halves = store.pair_halves(&pair)?;
    let out = halves.iter().find(|h| h.amount_cents < 0);
    let inn = halves.iter().find(|h| h.amount_cents > 0);
    let out = match (out, inn) {
        (Some(out), Some(inn)) if out.currency != inn.currency => out,
        _ => return Err(AppError::new("transfers.same_currency", "Only a transfer between currencies has an exchange cost.")),
    };
    if cost_cents >= -out.amount_cents {
        return Err(AppError::new("transfers.cost_too_high", "The cost must be less than the amount sent."));
    }
    if cost_category(store)?.is_none() {
        return Err(AppError::new("transfers.no_fee_category", "Add an expense category for fees first; the cost is booked there."));
    }
    store.transaction::<_, AppError, _>(|s| book_cost(s, out.id, cost_cents))?;
    Ok(cost_cents.max(0))
}

/// The exchange cost booked on a pair (outgoing account's currency), or `None` when there is none.
fn transfer_cost<S: Store>(store: &S, id: i64) -> AppResult<Option<i64>> {
    let Some(pair) = pair_of(store, id)? else { return Ok(None) };
    let Some(out) = store.pair_out_id(&pair)? else { return Ok(None) };
    if !is_cost_split(store, out)? {
        return Ok(None);
    }
    let fees_category = cost_category(store)?;
    Ok(list_splits(store, out)?
        .into_iter()
        .find(|p| p.note.as_deref() == Some("Exchange cost") || (p.category_id.is_some() && p.category_id == fees_category))
        .map(|p| -p.amount_cents))
}

/// For the transaction window: whether a pair is between currencies, and its cost in the sending currency.
pub fn transfer_cost_info<S: Store>(store: &S, id: i64) -> AppResult<TransferCostInfo> {
    let Some(pair) = pair_of(store, id)? else { return Ok(TransferCostInfo { cross: false, currency: None, cost_cents: None }) };
    let halves = store.pair_halves(&pair)?;
    let out = halves.iter().find(|h| h.amount_cents < 0);
    let currencies: HashSet<&str> = halves.iter().map(|h| h.currency.as_str()).collect();
    let cross = currencies.len() > 1;
    Ok(TransferCostInfo {
        cross,
        currency: out.map(|o| o.currency.clone()),
        cost_cents: if cross { transfer_cost(store, id)? } else { None },
    })
}

/// Separates the two halves again (their categories stay as they are; a booked exchange cost is removed).
pub fn unpair_transfer<S: Store>(store: &S, id: i64) -> AppResult<()> {
    let Some(pair) = pair_of(store, id)? else { return Ok(()) };
    store.transaction::<_, AppError, _>(|s| {
        for h in s.pair_halves(&pair)? {
            if is_cost_split(s, h.id)? {
                set_splits(s, h.id, &[])?;
            }
        }
        Ok(s.pair_clear(&pair)?)
    })
}
