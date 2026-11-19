//! The Overview's data and how it reaches the screen: what `pages/Overview.tsx` and `Suggestions.tsx` ask the core for,
//! and the texts, money and models the Slint globals get from it.
use crate::format::{month_label, month_short, Formats, MONTHS};
use crate::{AccountRow, AlertRow, App, Ov, TipRow};
use kb_i18n::Catalog;
use kb_service::{AppError, AppService, LoadStep};
use serde_json::{json, Value};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel};

pub type Res = Result<Value, AppError>;

pub struct OverviewData {
    pub year: i32,
    pub month: u32,
    pub prefs: Res,
    pub settings: Res,
    pub accounts: Res,
    pub summary: Res,
    pub alerts: Res,
    pub insights: Res,
    pub assistant: Res,
    pub preview: Res,
}

/// Shown tips before "Show all".
const SHOWN: usize = 3;

fn call(service: &dyn AppService, op: &str, input: Value) -> Res {
    kb_service::block_on(service.invoke(op, input))
}

/// Loads what the Overview needs, reporting real progress: the alerts are the inputs of the "Loading transactions" step,
/// the six queries behind the screen are the "Preparing the overview" step.
pub fn fetch(service: &dyn AppService, year: i32, month: u32, progress: &mut dyn FnMut(LoadStep, u64, u64)) -> OverviewData {
    let key = format!("{year:04}-{month:02}");
    progress(LoadStep::Transactions, 0, 1);
    let alerts = call(service, "alerts.list", json!({}));
    progress(LoadStep::Transactions, 1, 1);
    const TOTAL: u64 = 6;
    let mut done = 0;
    let mut step = |progress: &mut dyn FnMut(LoadStep, u64, u64), res: Res| {
        done += 1;
        progress(LoadStep::Overview, done, TOTAL);
        res
    };
    progress(LoadStep::Overview, 0, TOTAL);
    let prefs = step(progress, call(service, "prefs.get", json!({})));
    let settings = step(progress, call(service, "settings.get", json!({})));
    let accounts = step(progress, call(service, "accounts.list", json!({})));
    let summary = step(progress, call(service, "summary.month", json!({ "month": key })));
    let insights = step(progress, call(service, "insights.get", json!({ "month": key })));
    let assistant = step(progress, call(service, "assistant.status", json!({})));
    let preview = call(service, "insights.preview", json!({ "month": key }));
    OverviewData { year, month, prefs, settings, accounts, summary, alerts, insights, assistant, preview }
}

/// The text for a section that could not load: the operation that is not ported yet is named, anything else says what the core said.
pub fn error_text(cat: &Catalog, op: &str, e: &AppError) -> String {
    if e.code == "op.not_ported" {
        cat.tv("native.opNotPorted", &[("op", op)])
    } else {
        e.message.clone()
    }
}

fn severity(kind: &str) -> &'static str {
    match kind {
        "over_budget" | "balance_low" | "charged_twice" | "late" => "warning",
        "price_up" | "category_up" | "no_budget" | "upcoming" | "subscriptions" => "tip",
        _ => "info",
    }
}

/// `actionOf`: the label key and the page of a tip's button.
fn action(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "over_budget" | "near_budget" => ("budgets", "budgets"),
        "no_budget" => ("setBudget", "budgets"),
        "category_up" => ("category", "transactions"),
        "charged_twice" | "unusual" => ("payments", "transactions"),
        _ => ("fixedCosts", "recurring"),
    }
}

/// `textVars`: the values of a fact written the way the person set up money and dates; the count (if any) for plurals.
fn text_vars(fact: &Value, fmt: &Formats) -> (Vec<(String, String)>, Option<i64>) {
    let mut vars = Vec::new();
    let mut count = None;
    for (k, v) in fact["values"].as_object().into_iter().flatten() {
        let text = if let Some(m) = v["money"].as_i64() {
            fmt.money(m, v["currency"].as_str().unwrap_or("EUR"))
        } else if let Some(d) = v["date"].as_str() {
            fmt.date(d)
        } else if let Some(c) = v["count"].as_i64() {
            if k == "count" {
                count = Some(c);
            }
            c.to_string()
        } else {
            v["text"].as_str().unwrap_or_default().to_string()
        };
        vars.push((k.clone(), text));
    }
    (vars, count)
}

fn strings<T: Into<SharedString> + Clone>(items: &[T]) -> ModelRc<SharedString> {
    ModelRc::new(VecModel::from(items.iter().cloned().map(Into::into).collect::<Vec<SharedString>>()))
}

pub struct Options {
    pub tips_all: bool,
    /// The year and month of today, for the month picker.
    pub today: (i32, u32),
}

/// Puts the data on the screen: every property of the `Ov` global.
pub fn apply(ui: &App, cat: &Catalog, fallback: &Formats, d: &OverviewData, opts: &Options) {
    let ov = ui.global::<Ov>();
    let fmt = d.prefs.as_ref().map_or_else(|_| fallback.clone(), |p| Formats::from_json(&p["formats"]));
    let main = d.settings.as_ref().ok().and_then(|s| s["currency"].as_str()).unwrap_or("EUR").to_string();
    let money = |c: i64| fmt.money(c, &main);
    let t = |k: &str| cat.t(k);
    let label = month_label(d.year, d.month);
    let key = format!("{:04}-{:02}", d.year, d.month);

    ov.set_title(t("overview.title").into());
    ov.set_year(d.year);
    ov.set_month(d.month as i32);
    ov.set_today_year(opts.today.0);
    ov.set_today_month(opts.today.1 as i32);
    ov.set_month_label(label.clone().into());
    ov.set_month_names(strings(&MONTHS));
    ov.set_income_label(t("overview.income").into());
    ov.set_spending_label(t("overview.spending").into());
    ov.set_left_label(t("overview.left").into());
    ov.set_eye_label(t("native.holdToShowNumbers").into());
    ov.set_accounts_title(t("overview.accounts").into());
    ov.set_trend_title(t("overview.trend").into());
    ov.set_trend_description(t("overview.trendHint").into());
    ov.set_categories_empty_title(t("overview.nothingYet").into());
    ov.set_categories_empty_body(t("overview.byCategoryEmpty").into());
    ov.set_category_description(label.clone().into());
    ov.set_income_legend(t("overview.income").into());
    ov.set_spending_legend(t("overview.spending").into());

    // The assistant: the review button and the tips button need it configured.
    let assistant = d.assistant.as_ref().ok();
    let configured = assistant.is_some_and(|a| a["configured"].as_bool().unwrap_or(false));
    let ai = assistant.and_then(|a| a["providerName"].as_str()).unwrap_or("Claude").to_string();
    let accounts = d.accounts.as_ref().ok().and_then(Value::as_array);
    let has_tx = accounts.is_some_and(|l| l.iter().any(|a| a["transactionCount"].as_i64().unwrap_or(0) > 0));
    ov.set_show_review(configured && has_tx);
    ov.set_review_text(cat.tv("overview.review", &[("ai", &ai)]).into());

    // Alerts.
    let alerts: Vec<AlertRow> = d
        .alerts
        .as_ref()
        .ok()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|a| {
            let budget = a["kind"] == "budget";
            let near = budget && a["level"] == "near";
            let cents = |k: &str| a[k].as_i64().unwrap_or(0);
            let text = if budget {
                let pct = if cents("budgetCents") > 0 {
                    (cents("spentCents") as f64 / cents("budgetCents") as f64 * 100.0).round() as i64
                } else {
                    0
                };
                let (name, spent, budget_text, pct) =
                    (a["name"].as_str().unwrap_or(""), money(cents("spentCents")), money(cents("budgetCents")), pct.to_string());
                cat.tv(
                    if a["level"] == "over" { "alerts.budgetOver" } else { "alerts.budgetNear" },
                    &[("name", name), ("spent", &spent), ("budget", &budget_text), ("pct", &pct)],
                )
            } else {
                let cur = a["currency"].as_str().unwrap_or(&main);
                let (lowest, due) = (fmt.money(cents("lowestCents"), cur), fmt.money(cents("dueCents"), cur));
                cat.tv(
                    "alerts.balance",
                    &[
                        ("name", a["name"].as_str().unwrap_or("")),
                        ("date", &fmt.date(a["until"].as_str().unwrap_or(""))),
                        ("lowest", &lowest),
                        ("due", &due),
                    ],
                )
            };
            AlertRow {
                key: a["key"].as_str().unwrap_or("").into(),
                text: text.into(),
                near,
                page: if budget { "budgets" } else { "recurring" }.into(),
            }
        })
        .collect();
    ov.set_alerts(ModelRc::new(VecModel::from(alerts)));

    // The month: stats, bars, trend.
    match &d.summary {
        Ok(s) => {
            ov.set_summary_error("".into());
            ov.set_income(money(s["incomeCents"].as_i64().unwrap_or(0)).into());
            ov.set_spending(money(s["spendingCents"].as_i64().unwrap_or(0)).into());
            let left = s["leftCents"].as_i64();
            ov.set_left(left.map_or("—".to_string(), money).into());
            ov.set_left_tone(
                match left {
                    None => "",
                    Some(l) if l < 0 => "negative",
                    Some(_) => "accent",
                }
                .into(),
            );
            ov.set_left_hint(
                left.map_or_else(
                    || t("overview.noBudgets"),
                    |_| cat.tv("overview.ofBudget", &[("budget", &money(s["budgetedCents"].as_i64().unwrap_or(0)))]),
                )
                .into(),
            );

            let rows: Vec<(String, i64)> = s["byCategory"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| {
                    (
                        if c["categoryId"].is_null() {
                            t("transactions.uncategorized")
                        } else {
                            c["name"].as_str().unwrap_or("").to_string()
                        },
                        c["cents"].as_i64().unwrap_or(0),
                    )
                })
                .collect();
            let shown = kb_ui::charts::category_rows(&rows, 8, "Other");
            ov.set_category_top(kb_ui::charts::category_top(&shown));
            let bars: Vec<crate::CategoryBar> = shown
                .iter()
                .map(|(n, c)| crate::CategoryBar { name: n.as_str().into(), cents: *c as i32, value: money(*c).into() })
                .collect();
            ov.set_categories(ModelRc::new(VecModel::from(bars)));

            let history: Vec<(u32, i64, i64)> = s["history"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|h| {
                    (
                        h["month"].as_str().and_then(|m| m.get(5..7)).and_then(|m| m.parse().ok()).unwrap_or(1),
                        h["incomeCents"].as_i64().unwrap_or(0),
                        h["spendingCents"].as_i64().unwrap_or(0),
                    )
                })
                .collect();
            ov.set_month_top(kb_ui::charts::month_top(&history.iter().map(|h| (h.1, h.2)).collect::<Vec<_>>()));
            let data: Vec<crate::MonthDatum> = history
                .iter()
                .map(|&(m, i, s)| crate::MonthDatum {
                    label: month_short(m).into(),
                    income: i as i32,
                    spending: s as i32,
                    income_text: money(i).into(),
                    spending_text: money(s).into(),
                })
                .collect();
            ov.set_months(ModelRc::new(VecModel::from(data)));
            let summary_rows: Vec<(String, String, String)> =
                history.iter().map(|&(m, i, s)| (month_short(m), money(i), money(s))).collect();
            ov.set_trend_summary(kb_ui::charts::month_summary(&summary_rows, &t("overview.income"), &t("overview.spending")).into());

            let uncategorised = s["uncategorized"].as_i64().unwrap_or(0);
            ov.set_uncategorized_text(
                if uncategorised > 0 { cat.tn("overview.uncategorized", Some(uncategorised), &[]) } else { String::new() }.into(),
            );
            ov.set_uncategorized_action(t("overview.review").into());
            let unconverted = s["unconverted"].as_i64().unwrap_or(0);
            ov.set_unconverted_text(if unconverted > 0 { cat.tn("fx.unconverted", Some(unconverted), &[]) } else { String::new() }.into());
            ov.set_unconverted_hint(t("fx.unconvertedHint").into());
        }
        Err(e) => {
            ov.set_summary_error(error_text(cat, "summary.month", e).into());
            ov.set_categories(ModelRc::default());
            ov.set_months(ModelRc::default());
            ov.set_uncategorized_text("".into());
            ov.set_unconverted_text("".into());
        }
    }

    // Accounts, with numbers hidden until the eye is held.
    match &d.accounts {
        Ok(list) => {
            ov.set_accounts_error("".into());
            let rows: Vec<AccountRow> = list
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| !a["archived"].as_bool().unwrap_or(false))
                .map(|a| {
                    let cur = a["currency"].as_str().unwrap_or(&main);
                    let other = if cur == main {
                        String::new()
                    } else {
                        a["balanceMainCents"].as_i64().map_or_else(|| t("fx.noRateShort"), |m| format!("≈ {}", money(m)))
                    };
                    let iban = a["iban"].as_str().unwrap_or("");
                    AccountRow {
                        name: a["name"].as_str().unwrap_or("").into(),
                        balance: fmt.money(a["balanceCents"].as_i64().unwrap_or(0), cur).into(),
                        other: other.into(),
                        number: kb_rules::iban::shown_account(iban, true).into(),
                        masked: kb_rules::iban::mask_account(iban).into(),
                    }
                })
                .collect();
            ov.set_accounts(ModelRc::new(VecModel::from(rows)));
        }
        Err(e) => {
            ov.set_accounts_error(error_text(cat, "accounts.list", e).into());
            ov.set_accounts(ModelRc::default());
        }
    }

    // Suggestions.
    let show_tips = d.prefs.as_ref().map_or(true, |p| p["insights"].as_bool().unwrap_or(true));
    ov.set_tips_visible(show_tips);
    ov.set_tips_get_text(cat.tv("insights.get", &[("ai", &ai)]).into());
    match &d.insights {
        Ok(view) => {
            ov.set_tips_error("".into());
            let facts: Vec<&Value> = view["facts"].as_array().into_iter().flatten().collect();
            let rows: Vec<TipRow> = facts
                .iter()
                .enumerate()
                .filter(|(i, _)| opts.tips_all || *i < SHOWN)
                .map(|(_, f)| {
                    let kind = f["kind"].as_str().unwrap_or("");
                    let (vars, count) = text_vars(f, &fmt);
                    let vars: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                    let body_key = if kind == "unusual" {
                        format!("insights.unusual.{}", if f["values"]["reason"]["text"] == "new" { "bodyNew" } else { "bodyHigher" })
                    } else {
                        format!("insights.{kind}.body")
                    };
                    let (label, page) = action(kind);
                    let sev = severity(kind);
                    TipRow {
                        key: f["key"].as_str().unwrap_or("").into(),
                        title: cat.tn(&format!("insights.{kind}.title"), count, &vars).into(),
                        body: cat.tn(&body_key, count, &vars).into(),
                        severity: sev.into(),
                        severity_label: t(&format!("insights.severity.{sev}")).into(),
                        action: t(&format!("insights.action.{label}")).into(),
                        page: page.into(),
                    }
                })
                .collect();
            ov.set_tips(ModelRc::new(VecModel::from(rows)));
            let n = facts.len().to_string();
            ov.set_tips_more(
                if facts.len() <= SHOWN {
                    String::new()
                } else if opts.tips_all {
                    t("insights.showLess")
                } else {
                    cat.tv("insights.showAll", &[("n", &n)])
                }
                .into(),
            );
            ov.set_tips_empty(cat.tv("insights.empty", &[("month", &label)]).into());
            ov.set_tips_show_get((configured && !facts.is_empty()).into());
            ov.set_tips_has_sent((configured && !facts.is_empty() && d.preview.is_ok()).into());
            ov.set_sent_text(d.preview.as_ref().ok().and_then(|p| p["text"].as_str()).unwrap_or("").into());
        }
        Err(e) => {
            ov.set_tips_error(error_text(cat, "insights.get", e).into());
            ov.set_tips(ModelRc::default());
            ov.set_tips_show_get(false);
            ov.set_tips_has_sent(false);
        }
    }
    let _ = key;
}
