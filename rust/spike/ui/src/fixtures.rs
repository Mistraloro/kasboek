//! Invented data. Keep in sync with tools/fixtures.json, which feeds the Electron reference screenshots.
use crate::strings::Locale;
use crate::{App, Strings};
use slint::{ComponentHandle, ModelRc, VecModel};

/// 1234567 cents -> "12.345,67 €" (the renderer's default formats: decimal comma, dot grouping, symbol after, NBSP).
pub fn money(cents: i64) -> String {
    let abs = cents.abs();
    let int = (abs / 100).to_string();
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push('.');
        }
        grouped.push(c);
    }
    format!(
        "{}{grouped},{:02}\u{a0}€",
        if cents < 0 { "-" } else { "" },
        abs % 100
    )
}

const INCOME: i64 = 325_000;
const SPENDING: i64 = 214_380;
const BUDGETED: i64 = 250_000;
const LEFT: i64 = 35_620;
const CATEGORIES: [(&str, i64); 6] = [
    ("Groceries", 48_250),
    ("Rent", 95_000),
    ("Transport", 21_400),
    ("Eating out", 18_730),
    ("Utilities", 15_600),
    ("Uncategorised", 15_400),
];
const HISTORY: [(&str, i64, i64); 6] = [
    ("Oct", 310_000, 228_000),
    ("Nov", 310_000, 241_500),
    ("Dec", 342_000, 297_800),
    ("Jan", 310_000, 205_300),
    ("Feb", 315_000, 198_900),
    ("Mar", 325_000, 214_380),
];

pub fn apply(ui: &App, en: &Locale, screen: &str, dark: bool) {
    ui.global::<crate::Theme>().set_dark(dark);
    ui.set_screen(screen.into());
    let s = ui.global::<Strings>();
    let ai = [("ai", "Claude")];
    s.set_app_name(en.t("app.name", &[]).into());
    s.set_version_short(en.t("app.versionShort", &[("version", "0.21.1")]).into());
    s.set_unlock_title(en.t("auth.unlockTitle", &[]).into());
    s.set_unlock_body(
        en.t(
            "auth.unlockDeviceBody",
            &[("name", &en.t("auth.windowsHello", &[]))],
        )
        .into(),
    );
    s.set_password(en.t("auth.password", &[]).into());
    s.set_hold_to_show(en.t("auth.holdToShowPassword", &[]).into());
    s.set_unlock_button(en.t("auth.unlock", &[]).into());
    s.set_unlock_with(
        en.t(
            "auth.unlockWith",
            &[("name", &en.t("auth.windowsHello", &[]))],
        )
        .into(),
    );
    s.set_forgot(en.t("auth.forgot", &[]).into());
    s.set_erase_link(en.t("auth.eraseLink", &[]).into());

    s.set_nav_overview(en.t("nav.overview", &[]).into());
    s.set_nav_transactions(en.t("nav.transactions", &[]).into());
    s.set_nav_budgets(en.t("nav.budgets", &[]).into());
    s.set_nav_recurring(en.t("nav.recurring", &[]).into());
    s.set_nav_goals(en.t("nav.goals", &[]).into());
    s.set_nav_year(en.t("nav.year", &[]).into());
    s.set_nav_networth(en.t("nav.networth", &[]).into());
    s.set_nav_import(en.t("nav.import", &[]).into());
    s.set_nav_settings(en.t("nav.settings", &[]).into());
    s.set_nav_lock(en.t("nav.lock", &[]).into());
    s.set_nav_assistant(en.t("nav.assistant", &[]).into());
    s.set_nav_toggle_assistant(en.t("nav.toggleAssistant", &[]).into());

    s.set_assistant_title(en.t("assistant.title", &ai).into());
    s.set_assistant_setup_body(en.t("assistant.setupBody", &[]).into());
    s.set_assistant_setup_button(en.t("assistant.setupButton", &[]).into());
    s.set_assistant_privacy(
        en.t(
            "assistant.privacy",
            &[("ai", "Claude"), ("aiCompany", "Anthropic")],
        )
        .into(),
    );

    let month = "March 2026";
    s.set_overview_title(en.t("overview.title", &[]).into());
    s.set_month_previous(en.t("monthNav.previous", &[]).into());
    s.set_month_next(en.t("monthNav.next", &[]).into());
    s.set_month_label(month.into());
    s.set_alert_text(
        en.t(
            "alerts.budgetOver",
            &[
                ("name", "Groceries"),
                ("spent", &money(48_250)),
                ("budget", &money(45_000)),
            ],
        )
        .into(),
    );
    s.set_income(en.t("overview.income", &[]).into());
    s.set_spending(en.t("overview.spending", &[]).into());
    s.set_left(en.t("overview.left", &[]).into());
    s.set_uncategorized_text(
        en.t("overview.uncategorized_other", &[("count", "3")])
            .into(),
    );
    s.set_review(en.t("overview.review", &ai).into());
    s.set_by_category(en.t("overview.byCategory", &[]).into());
    s.set_get_started(en.t("overview.getStarted", &[]).into());
    s.set_get_started_hint(en.t("overview.getStartedHint", &[]).into());
    s.set_open(en.t("overview.open", &[]).into());
    s.set_trend(en.t("overview.trend", &[]).into());
    s.set_trend_hint(en.t("overview.trendHint", &[]).into());

    ui.set_income(money(INCOME).into());
    ui.set_spending(money(SPENDING).into());
    ui.set_left(money(LEFT).into());
    ui.set_left_hint(
        en.t("overview.ofBudget", &[("budget", &money(BUDGETED))])
            .into(),
    );

    let top = CATEGORIES.iter().map(|c| c.1).max().unwrap_or(1) as f32;
    let rows: Vec<crate::CategoryRow> = CATEGORIES
        .iter()
        .map(|(n, c)| crate::CategoryRow {
            name: (*n).into(),
            amount: money(*c).into(),
            fraction: *c as f32 / top,
        })
        .collect();
    ui.set_categories(ModelRc::new(VecModel::from(rows)));

    // Row heights are measured from the Electron page for this fixture (Slint layouts have no height-for-width).
    let step = |done: bool, lines: &[&str], body: String, number: &str, bh: f32| crate::Step {
        done,
        title: lines.join(" ").into(),
        title_lines: ModelRc::new(VecModel::from(
            lines
                .iter()
                .map(|l| (*l).into())
                .collect::<Vec<slint::SharedString>>(),
        )),
        body: body.into(),
        number: number.into(),
        body_height: bh,
    };
    let steps = vec![
        step(
            true,
            &["Add your bank accounts"],
            en.t("overview.stepAccountsBody", &[]),
            "1",
            32.0,
        ),
        step(
            true,
            &["Import a CSV export or", "PDF statement"],
            en.t("overview.stepImportBody", &[]),
            "2",
            48.0,
        ),
        step(
            false,
            &["Turn on", "automatic", "backups"],
            en.t("overview.stepBackupBody", &[]),
            "3",
            64.0,
        ),
    ];
    ui.set_steps(ModelRc::new(VecModel::from(steps)));

    let top = HISTORY.iter().flat_map(|h| [h.1, h.2]).max().unwrap_or(1) as f32;
    let months: Vec<crate::MonthBar> = HISTORY
        .iter()
        .map(|(l, i, s)| crate::MonthBar {
            label: (*l).into(),
            income: *i as f32 / top,
            spending: *s as f32 / top,
        })
        .collect();
    ui.set_months(ModelRc::new(VecModel::from(months)));

    // Text alternative of the trend chart: "Trend: Oct: Income 3.100,00 €, Spending 2.280,00 €; Nov: ...".
    let (income, spending) = (en.t("overview.income", &[]), en.t("overview.spending", &[]));
    let per_month: Vec<String> = HISTORY
        .iter()
        .map(|(l, i, sp)| format!("{l}: {income} {}, {spending} {}", money(*i), money(*sp)))
        .collect();
    s.set_trend_summary(
        format!("{}: {}", en.t("overview.trend", &[]), per_month.join("; ")).into(),
    );
}

/// Names the device in the two Lock texts: Windows Hello (the default of `apply`) or Touch ID on a Mac.
pub fn set_device(ui: &App, en: &Locale, touch_id: bool) {
    let name = en.t(
        if touch_id {
            "auth.touchId"
        } else {
            "auth.windowsHello"
        },
        &[],
    );
    let s = ui.global::<Strings>();
    s.set_unlock_body(en.t("auth.unlockDeviceBody", &[("name", &name)]).into());
    s.set_unlock_with(en.t("auth.unlockWith", &[("name", &name)]).into());
}
