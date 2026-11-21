//! The parts of src/core/insight-plan.ts that the local insights need (batch B2): the text that would be sent to the
//! assistant (`factsPayload`, the one source for the dialog where the person agrees and for the request), the system prompt,
//! and, for the preview, the provider that is in use (`activeProvider`, `requireConfigured`, `shownAddress` of
//! src/main/assistant/provider.ts with the presets of src/shared/ai-providers.ts). Reading and checking the assistant's
//! answer (`parseSuggestions`, `verifySuggestions`) comes with the batch that runs it.
use crate::dates::js_round;
use crate::error::{AppError, AppResult};
use crate::insights::{InsightFact, InsightValue};
use crate::jsstr::{collapse_spaces, js_trim};
use kb_db::Store;
use kb_rules::mask::mask_private;
use serde_json::{Map, Value};
use std::collections::HashMap;
use url::Url;

/// The most tips kept, and the most the assistant may write (one more is allowed, in case one is rejected).
pub const MAX_TIPS: usize = 5;
/// A name (payee, category, account) is cut to this many characters before it is sent.
pub const NAME_LIMIT: usize = 40;
/// The most names sent in the list of fixed costs.
const MAX_NAMES: usize = 15;
/// Roughly how many characters a token is, for the estimate shown before anything is sent.
pub const CHARS_PER_TOKEN: usize = 3;

/// `INSIGHT_INSTRUCTIONS`, written by the TypeScript (the tests compare it with the one the TypeScript builds).
pub const INSIGHT_INSTRUCTIONS: &str = include_str!("insight_instructions.txt");

/// Interface languages, each named in its own language (`LANGUAGES` of src/shared/languages.ts).
const LANGUAGE_NAMES: [(&str, &str); 8] = [
    ("en", "English"),
    ("nl", "Nederlands"),
    ("fr", "Français"),
    ("de", "Deutsch"),
    ("es", "Español (España)"),
    ("es-419", "Español (Latinoamérica)"),
    ("pt-PT", "Português (Portugal)"),
    ("pt-BR", "Português (Brasil)"),
];

/// The language named in itself, as written in prompts; English for a code that is not known.
pub fn language_name(code: &str) -> &'static str {
    LANGUAGE_NAMES.iter().find(|(c, _)| *c == code).map_or("English", |(_, name)| name)
}

/// The system prompt, ending with the language the tips are written in.
pub fn insights_system(language: &str) -> String {
    format!("{INSIGHT_INSTRUCTIONS}\n\nWrite in {}.", language_name(language))
}

/// Values that are never sent, whatever the fact: the balance of an account.
fn not_sent(kind: &str) -> &'static [&'static str] {
    if kind == "balance_low" {
        &["balance", "lowest"]
    } else {
        &[]
    }
}

/// The fields of a fact the assistant may see and name in a placeholder.
pub fn sent_fields(f: &InsightFact) -> Vec<&str> {
    f.values.iter().map(|(k, _)| k.as_str()).filter(|k| !not_sent(f.kind).contains(k)).collect()
}

/// A name as it is sent: no line breaks or separators (it can't pose as another fact), numbers hidden, cut short.
fn send_name(text: &str) -> String {
    let masked = mask_private(text, Some(2000));
    let mut apart = String::with_capacity(masked.len());
    let mut in_run = false;
    for c in masked.chars() {
        if matches!(c, '\r' | '\n' | '\t' | '|') {
            if !in_run {
                apart.push(' ');
            }
            in_run = true;
        } else {
            apart.push(c);
            in_run = false;
        }
    }
    js_trim(&collapse_spaces(&apart)).chars().take(NAME_LIMIT).collect()
}

/// A whole number the way a JavaScript template prints it (`${-0}` is `0`).
pub fn js_int_text(x: f64) -> String {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.2e18 {
        (x as i64).to_string()
    } else {
        x.to_string()
    }
}

/// The text to send for the facts, and the fields of each that can be named. Sent: a fact's kind, names (payees and categories,
/// masked and cut short; an account as "account 1"), amounts rounded to whole units with their currency, counts and dates.
/// Never sent: transaction ids, category ids, fixed-cost keys, account names, balances, income, descriptions or lists of
/// transactions.
pub fn facts_payload(facts: &[InsightFact], currency: &str, month: &str, today: &str) -> (String, HashMap<String, Vec<String>>) {
    let mut accounts: Vec<&str> = Vec::new();
    let mut fields = HashMap::new();
    let mut lines = Vec::with_capacity(facts.len());
    for f in facts {
        let sent = sent_fields(f);
        let mut parts = vec![format!("{} {}", f.id, f.kind)];
        for key in &sent {
            let Some((_, v)) = f.values.iter().find(|(k, _)| k == key) else { continue };
            parts.push(match v {
                InsightValue::Money { money, currency } => format!("{key}≈{} {currency}", js_int_text(js_round(money / 100.0))),
                InsightValue::Date(date) => format!("{key}: {date}"),
                InsightValue::Count(count) => format!("{key}: {}", js_int_text(*count)),
                InsightValue::Text(text) if f.kind == "balance_low" && *key == "name" => {
                    let n = accounts.iter().position(|a| a == text).unwrap_or_else(|| {
                        accounts.push(text);
                        accounts.len() - 1
                    });
                    format!("{key}: account {}", n + 1)
                }
                InsightValue::Text(text) if f.kind == "subscriptions" && *key == "names" => {
                    let names: Vec<String> = text.split(", ").take(MAX_NAMES).map(send_name).collect();
                    format!("{key}: {}", names.join(", "))
                }
                InsightValue::Text(text) => format!("{key}: {}", send_name(text)),
            });
        }
        fields.insert(f.id.clone(), sent.iter().map(|k| (*k).to_owned()).collect());
        lines.push(parts.join(" | "));
    }
    let header = [format!("Main currency: {currency}"), format!("Month: {month}"), format!("Today: {today}")].join("\n");
    (format!("{header}\n\n{}", lines.join("\n")), fields)
}

/* ----- the provider in use (src/shared/ai-providers.ts, ai-provider-store.ts, main/assistant/provider.ts) ----- */

/// What a provider is called and where it is (`ProviderPreset`).
#[derive(Debug, Clone)]
pub struct Preset {
    pub id: String,
    pub name: String,
    /// What the assistant is called in the app ("Ask Mistral…").
    pub assistant_name: String,
    /// Who receives the data; `None` for providers on the person's own machine.
    pub company: Option<&'static str>,
    pub base_url: &'static str,
    /// The base URL may be changed (local servers on another port or computer, or a custom server).
    pub editable_url: bool,
    pub needs_key: bool,
}

/// `(id, name, company, base URL, editable URL, needs a key)` of `PROVIDERS`; the assistant name is the name for all of them.
#[allow(clippy::type_complexity)]
const BUILTIN: [(&str, &str, Option<&str>, &str, bool, bool); 10] = [
    ("anthropic", "Claude", Some("Anthropic"), "https://api.anthropic.com", false, true),
    ("mistral", "Mistral", Some("Mistral AI"), "https://api.mistral.ai/v1", false, true),
    ("groq", "Groq", Some("Groq"), "https://api.groq.com/openai/v1", false, true),
    ("deepseek", "DeepSeek", Some("DeepSeek"), "https://api.deepseek.com/v1", false, true),
    ("ollama", "Ollama", None, "http://localhost:11434/v1", true, false),
    ("lmstudio", "LM Studio", None, "http://localhost:1234/v1", true, false),
    ("openrouter", "OpenRouter", Some("OpenRouter and the model’s provider"), "https://openrouter.ai/api/v1", false, true),
    ("together", "Together AI", Some("Together AI"), "https://api.together.xyz/v1", false, true),
    ("fireworks", "Fireworks AI", Some("Fireworks AI"), "https://api.fireworks.ai/inference/v1", false, true),
    ("gemini", "Gemini", Some("Google"), "https://generativelanguage.googleapis.com/v1beta/openai", false, true),
];

/// `isCustomId`.
pub fn is_custom_id(id: &str) -> bool {
    id == "custom" || id.starts_with("custom-")
}

/// `presetFor`: a custom provider carries the name the person gave it; an unknown id is Claude.
pub fn preset_for(id: &str, name: Option<&str>) -> Preset {
    if is_custom_id(id) {
        let name = name.filter(|n| !n.is_empty()).unwrap_or("Other (OpenAI-compatible)");
        return Preset {
            id: id.to_owned(),
            name: name.to_owned(),
            assistant_name: "Assistant".to_owned(),
            company: Some("the server you entered"),
            base_url: "",
            editable_url: true,
            needs_key: false,
        };
    }
    let (id, name, company, base_url, editable_url, needs_key) = BUILTIN.iter().find(|p| p.0 == id).copied().unwrap_or(BUILTIN[0]);
    Preset { id: id.to_owned(), name: name.to_owned(), assistant_name: name.to_owned(), company, base_url, editable_url, needs_key }
}

/// Loopback and private network addresses, where plain http is acceptable.
fn is_local_host(host: &str) -> bool {
    let h = host.strip_prefix('[').unwrap_or(host);
    let h = h.strip_suffix(']').unwrap_or(h).to_lowercase();
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h == "::1" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 || !parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let (Ok(a), Ok(b)) = (parts[0].parse::<u64>(), parts[1].parse::<u64>()) else { return false };
    a == 127 || a == 10 || (a == 192 && b == 168) || (a == 172 && (16..=31).contains(&b))
}

/// Whether calls to this address need an API key: a custom one needs a key unless it is on this computer or the local network.
fn key_required(preset: &Preset, base_url: &str) -> bool {
    if !is_custom_id(&preset.id) {
        return preset.needs_key;
    }
    Url::parse(base_url).ok().and_then(|u| u.host_str().map(|h| !is_local_host(h))).unwrap_or(true)
}

/// `checkBaseUrl`: https, or http only on this computer or the local network (keys must not travel in the clear).
fn check_base_url(url: &str) -> Option<&'static str> {
    let Ok(u) = Url::parse(url) else { return Some("Enter a full address, like https://api.example.com/v1.") };
    if !u.username().is_empty() || u.password().is_some_and(|p| !p.is_empty()) {
        return Some("Put the key in the key field, not in the address.");
    }
    match u.scheme() {
        "https" => None,
        "http" if u.host_str().is_some_and(is_local_host) => None,
        "http" => Some("Use https for servers outside this computer or your local network."),
        _ => Some("Use an http or https address."),
    }
}

/// What a call to the provider in use needs (`ActiveProvider`).
#[derive(Debug, Clone)]
pub struct ActiveProvider {
    pub preset: Preset,
    pub base_url: String,
    pub chat_model: String,
    /// The model that words the tips on the Overview: the cheapest for Claude, else the model for reading files.
    pub insights_model: String,
    pub key: Option<String>,
}

/// The name Claude's key is kept under; the others are `aiKey.<id>` (`keyName`).
fn key_name(id: &str) -> String {
    if id == "anthropic" {
        "anthropicApiKey".to_owned()
    } else {
        format!("aiKey.{id}")
    }
}

/// JavaScript truthiness of a stored setting.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn text_of<'a>(settings: &'a Map<String, Value>, key: &str) -> &'a str {
    settings.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `activeProvider`: every request to a provider starts here, so none can be made while the assistant is off.
pub fn active_provider<S: Store>(store: &S, settings: &Map<String, Value>) -> AppResult<ActiveProvider> {
    if !settings.get("assistantEnabled").is_some_and(truthy) {
        return Err(AppError::new("assistant.disabled", "The assistant is turned off. Turn it on in Settings → Assistant."));
    }
    // A stored provider id that is not text breaks `presetFor` in the TypeScript: "Something went wrong".
    let id = settings.get("aiProvider").and_then(Value::as_str).ok_or_else(AppError::failed)?;
    let name = settings.get("aiProviders").and_then(|p| p.get(id)).and_then(|p| p.get("name")).and_then(Value::as_str);
    let preset = preset_for(id, name);
    let (chat, csv) = (text_of(settings, "aiChatModel"), text_of(settings, "aiCsvModel"));
    let custom_url = text_of(settings, "aiBaseUrl");
    let base_url = if preset.editable_url && !custom_url.is_empty() { custom_url } else { preset.base_url };
    let file_model = if csv.is_empty() { chat } else { csv };
    let insights_model = if id == "anthropic" { "claude-haiku-5-5" } else { file_model };
    let key = store.insights_secret(&key_name(&preset.id))?;
    Ok(ActiveProvider {
        base_url: base_url.to_owned(),
        chat_model: chat.to_owned(),
        insights_model: insights_model.to_owned(),
        key,
        preset,
    })
}

/// `requireConfigured`: refuses when the provider lacks its key, a valid address or a chat model (checked in this order).
pub fn require_configured(p: &ActiveProvider) -> AppResult<()> {
    let has_key = p.key.as_deref().is_some_and(|k| !k.is_empty());
    if p.preset.id == "anthropic" {
        return if has_key { Ok(()) } else { Err(no_key(p)) };
    }
    if key_required(&p.preset, &p.base_url) && !has_key {
        return Err(no_key(p));
    }
    if p.base_url.is_empty() || check_base_url(&p.base_url).is_some() {
        let message = check_base_url(&p.base_url)
            .map_or_else(|| format!("Enter the address of {} in Settings → Assistant first.", p.preset.name), str::to_owned);
        return Err(AppError::new("assistant.bad_url", message));
    }
    if p.chat_model.is_empty() {
        return Err(AppError::new("assistant.no_model", format!("Choose a {} model in Settings → Assistant first.", p.preset.name)));
    }
    Ok(())
}

fn no_key(p: &ActiveProvider) -> AppError {
    let who = if p.preset.id == "anthropic" { "Anthropic" } else { &p.preset.name };
    AppError::new("assistant.no_key", format!("Add your {who} API key in Settings → Assistant first."))
}

/// `shownAddress`: where requests go, as shown in the dialogs where the person agrees: only the host of an online provider,
/// the whole address of one the person can point anywhere.
pub fn shown_address(p: &ActiveProvider) -> String {
    if p.preset.editable_url {
        return p.base_url.clone();
    }
    match Url::parse(&p.base_url).ok().and_then(|u| u.host_str().map(|h| (h.to_owned(), u.port()))) {
        Some((host, Some(port))) => format!("{host}:{port}"),
        Some((host, None)) => host,
        None => p.base_url.clone(),
    }
}
