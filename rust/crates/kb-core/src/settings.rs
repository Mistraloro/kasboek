//! Settings stored in the database (`settings` table, JSON values): src/core/settings.ts.
use crate::error::AppResult;
use kb_db::rows::ImportResetFacts;
use kb_db::Store;
use serde_json::{json, Map, Value};

/// `DEFAULT_SETTINGS`, in the order of the TypeScript object (the order of the keys in `settings.get`).
pub fn defaults() -> Map<String, Value> {
    let Value::Object(map) = json!({
        "currency": "EUR",
        "fxAutoUpdate": false,
        "fxLastEcbUpdateAt": null,
        "autoBackupEnabled": false,
        "autoBackupFolder": null,
        "autoBackupKeep": 10,
        "lastBackupAt": null,
        "lastBackupFile": null,
        "chatModel": "claude-sonnet-5-5",
        "chatEffort": "medium",
        "csvModel": "claude-opus-5-5",
        "csvEffort": "medium",
        "mcpEnabled": false,
        "aiProvider": "anthropic",
        "aiBaseUrl": null,
        "aiChatModel": "",
        "aiCsvModel": "",
        "aiPdfModel": "",
        "aiProviders": {},
        "savedSearches": [],
        "aiReasoning": "default",
        "aiCsvReasoning": "default",
        "permissions": { "mode": "ask", "rules": {}, "mcpAlwaysAsk": true },
        "memoryEnabled": true,
        "pageContextEnabled": true,
        "aiInsightsConsent": null,
        "aiCheckConsent": null
    }) else {
        unreachable!("an object literal")
    };
    map
}

/// The defaults with every stored value laid over them. A stored value that is not valid JSON is ignored; stored keys
/// that are not settings are ignored.
pub fn get_settings<S: Store>(store: &S) -> AppResult<Map<String, Value>> {
    let stored: std::collections::HashMap<String, Value> =
        store.settings_rows()?.into_iter().filter_map(|(key, value)| serde_json::from_str(&value).ok().map(|v| (key, v))).collect();
    let mut merged = defaults();
    for (key, value) in merged.iter_mut() {
        if let Some(stored_value) = stored.get(key) {
            *value = stored_value.clone();
        }
    }
    Ok(merged)
}

/// Writes the keys of `patch` that are settings, in one transaction; returns the settings as they are afterwards.
pub fn update_settings<S: Store>(store: &S, patch: &Map<String, Value>) -> AppResult<Map<String, Value>> {
    let known = defaults();
    store.transaction::<_, kb_db::DbError, _>(|s| {
        for (key, value) in patch {
            if known.contains_key(key) {
                s.setting_set(key, &value.to_string())?;
            }
        }
        Ok(())
    })?;
    get_settings(store)
}

/// Settings that decide where data is sent, what the assistant may do and where files are written, plus the agreements
/// to send tips data and CSV rows to a provider.
const UNTRUSTED_AFTER_IMPORT: [&str; 10] = [
    "aiBaseUrl",
    "aiProvider",
    "aiProviders",
    "permissions",
    "mcpEnabled",
    "autoBackupFolder",
    "autoBackupEnabled",
    "memoryEnabled",
    "aiInsightsConsent",
    "aiCheckConsent",
];

/// After an import or a sync join: what a file from elsewhere must not bring (its AI address, permissions, backup folder,
/// memory, agreements, API keys, and the sync key unless this is a join) goes back to the defaults. One transaction.
/// Returns which of those actually held something, in the order of `ImportReset` in src/shared/types.ts.
pub fn reset_imported_settings<S: Store>(store: &S, keep_sync_key: bool) -> AppResult<Vec<&'static str>> {
    Ok(store.transaction::<_, kb_db::DbError, _>(|s| {
        let ImportResetFacts { ai_key, ai_endpoint, permissions, mcp, auto_backup, memory, sync } = s.import_reset_facts(keep_sync_key)?;
        let found: Vec<&'static str> = [
            (ai_key, "aiKey"),
            (ai_endpoint, "aiEndpoint"),
            (permissions, "permissions"),
            (mcp, "mcp"),
            (auto_backup, "autoBackup"),
            (memory, "memory"),
            (sync, "sync"),
        ]
        .into_iter()
        .filter_map(|(hit, name)| hit.then_some(name))
        .collect();
        s.import_reset_apply(&UNTRUSTED_AFTER_IMPORT, keep_sync_key)?;
        Ok(found)
    })?)
}
