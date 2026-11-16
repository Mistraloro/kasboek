/** The tabs of the Settings page, and which one it opens on. */
export const SETTINGS_TABS = ['general', 'accounts', 'security', 'data', 'assistant'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/** The last tab used, or the one a link asked for. Kept while Kasboek runs. */
let current: SettingsTab = 'general'

export function settingsTab(): SettingsTab {
  return current
}

/** For links into Settings ("Add an account", "Turn on backups"): call before going there. */
export function openSettingsTab(tab: SettingsTab): void {
  current = tab
}
