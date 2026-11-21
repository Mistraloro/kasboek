//! `transactions.list`, `.create`, `.update`, `.edit`, `.splits`, `.split`, `.rename`, `.categorize`, `.delete`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::finance::{
    categorize_transactions, create_transaction, delete_transactions, list_splits, list_transactions, month_range, rename_transactions,
    set_splits, update_transaction, ListFilter, NewTx, SplitPart, TxChange,
};
use crate::input::{is_none, nullable, nullable_optional, optional, Cents, Date, Id, IdOrNone, IntIn, LenVec, Month, Plain, Trimmed};
use kb_db::rows::{CategoryFilter, Direction};
use kb_db::Store;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{json as obj, Value};

#[derive(Deserialize, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Dir {
    In,
    Out,
}

fn default_limit() -> IntIn<1, 500> {
    IntIn(100)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ListIn {
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    account_id: Option<Id>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    category_id: Option<IdOrNone>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    month: Option<Month>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    from: Option<Date>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    to: Option<Date>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    search: Option<Plain<100>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    direction: Option<Dir>,
    #[serde(default = "default_limit")]
    limit: IntIn<1, 500>,
    #[serde(default)]
    offset: IntIn<0, 9_007_199_254_740_991>,
}

pub fn list<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: ListIn| {
        let db = core.db()?;
        let main = crate::settings::get_settings(db)?.get("currency").and_then(Value::as_str).unwrap_or("EUR").to_owned();
        let filter = ListFilter {
            account_id: i.account_id.map(|a| a.0),
            category: i.category_id.map(|c| match c {
                IdOrNone::None => CategoryFilter::None,
                IdOrNone::Id(id) => CategoryFilter::Id(id.0),
            }),
            month: i.month.as_ref().map(|m| month_range(&m.0)),
            from: i.from.map(|d| d.0),
            to: i.to.map(|d| d.0),
            search: i.search.map(|s| s.0),
            direction: i.direction.map(|d| match d {
                Dir::In => Direction::In,
                Dir::Out => Direction::Out,
            }),
            limit: i.limit.0,
            offset: i.offset.0,
        };
        json(&list_transactions(db, &filter, &main)?)
    })
}

/// `cents.refine((v) => v !== 0, 'Amount can’t be zero.')`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(transparent)]
struct NonZeroCents(Cents);

impl<'de> Deserialize<'de> for NonZeroCents {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let c = Cents::deserialize(d)?;
        if c.0 == 0 {
            Err(de::Error::custom("Amount can’t be zero."))
        } else {
            Ok(Self(c))
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateIn {
    account_id: Id,
    booking_date: Date,
    amount_cents: NonZeroCents,
    description: Trimmed<1, 300>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    counterparty_name: Option<Option<Trimmed<0, 120>>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    category_id: Option<Option<Id>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    notes: Option<Option<Plain<1000>>>,
}

pub fn create<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CreateIn| {
        let tx = NewTx {
            account_id: i.account_id.0,
            booking_date: i.booking_date.0,
            amount_cents: i.amount_cents.0 .0,
            description: i.description.0,
            counterparty_name: i.counterparty_name.flatten().map(|n| n.0),
            category_id: i.category_id.flatten().map(|c| c.0),
            notes: i.notes.flatten().map(|n| n.0),
        };
        json(&create_transaction(core.db()?, &tx)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UpdateIn {
    id: Id,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    category_id: Option<Option<Id>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    notes: Option<Option<Plain<1000>>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    description: Option<Trimmed<1, 300>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    booking_date: Option<Date>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    amount_cents: Option<Cents>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    counterparty_name: Option<Option<Trimmed<0, 120>>>,
}

pub fn update<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: UpdateIn| {
        json(&update_transaction(
            core.db()?,
            &TxChange {
                id: i.id.0,
                category_id: i.category_id.map(|c| c.map(|c| c.0)),
                notes: i.notes.map(|n| n.map(|n| n.0)),
                description: i.description.map(|d| d.0),
                booking_date: i.booking_date.map(|d| d.0),
                amount_cents: i.amount_cents.map(|c| c.0),
                counterparty_name: i.counterparty_name.map(|n| n.map(|n| n.0)),
            },
        )?)
    })
}

/// The assistant's version: no dates or amounts.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EditIn {
    id: Id,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    category_id: Option<Option<Id>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    notes: Option<Option<Plain<1000>>>,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    description: Option<Trimmed<1, 300>>,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    counterparty_name: Option<Option<Trimmed<0, 120>>>,
}

pub fn edit<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: EditIn| {
        json(&update_transaction(
            core.db()?,
            &TxChange {
                id: i.id.0,
                category_id: i.category_id.map(|c| c.map(|c| c.0)),
                notes: i.notes.map(|n| n.map(|n| n.0)),
                description: i.description.map(|d| d.0),
                booking_date: None,
                amount_cents: None,
                counterparty_name: i.counterparty_name.map(|n| n.map(|n| n.0)),
            },
        )?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IdIn {
    id: Id,
}

pub fn splits<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: IdIn| json(&list_splits(core.db()?, i.id.0)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PartIn {
    #[serde(deserialize_with = "nullable")]
    category_id: Option<Id>,
    amount_cents: Cents,
    #[serde(default, deserialize_with = "nullable_optional", skip_serializing_if = "is_none")]
    note: Option<Option<Plain<200>>>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SplitIn {
    id: Id,
    parts: LenVec<PartIn, 0, 20>,
}

pub fn split<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: SplitIn| {
        let parts: Vec<SplitPart> = i
            .parts
            .0
            .into_iter()
            .map(|p| SplitPart {
                category_id: p.category_id.map(|c| c.0),
                amount_cents: p.amount_cents.0,
                note: p.note.flatten().map(|n| n.0),
            })
            .collect();
        json(&set_splits(core.db()?, i.id.0, &parts)?)
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenameIn {
    ids: LenVec<Id, 1, 5000>,
    counterparty_name: Trimmed<1, 120>,
}

pub fn rename<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: RenameIn| {
        let ids: Vec<i64> = i.ids.0.iter().map(|id| id.0).collect();
        Ok(obj!({ "updated": rename_transactions(core.db()?, &ids, &i.counterparty_name.0)? }))
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CategorizeIn {
    ids: LenVec<Id, 1, 5000>,
    #[serde(deserialize_with = "nullable")]
    category_id: Option<Id>,
}

pub fn categorize<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: CategorizeIn| {
        let ids: Vec<i64> = i.ids.0.iter().map(|id| id.0).collect();
        Ok(obj!({ "updated": categorize_transactions(core.db()?, &ids, i.category_id.map(|c| c.0))? }))
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DeleteIn {
    ids: LenVec<Id, 1, 5000>,
}

pub fn delete<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: DeleteIn| {
        let ids: Vec<i64> = i.ids.0.iter().map(|id| id.0).collect();
        Ok(obj!({ "deleted": delete_transactions(core.db()?, &ids)? }))
    })
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &[
    "transactions.list",
    "transactions.create",
    "transactions.update",
    "transactions.edit",
    "transactions.splits",
    "transactions.split",
    "transactions.rename",
    "transactions.categorize",
    "transactions.delete",
];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "transactions.list" => list::<S>,
        "transactions.create" => create::<S>,
        "transactions.update" => update::<S>,
        "transactions.edit" => edit::<S>,
        "transactions.splits" => splits::<S>,
        "transactions.split" => split::<S>,
        "transactions.rename" => rename::<S>,
        "transactions.categorize" => categorize::<S>,
        "transactions.delete" => delete::<S>,
        _ => return None,
    })
}
