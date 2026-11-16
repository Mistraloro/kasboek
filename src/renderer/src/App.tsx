import { ArrowLeftRight, CalendarRange, FileUp, LayoutDashboard, Lock as LockIcon, PanelRight, PiggyBank, Repeat, Settings as SettingsIcon, Target, TrendingUp } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AssistantPanel } from './components/AssistantPanel'
import { Mark } from './components/Mark'
import { McpRequests } from './components/McpRequests'
import { UpdateButton } from './components/Update'
import { Tour } from './components/Tour'
import { openSettingsTab } from './lib/settings-tab'
import { Welcome } from './pages/Welcome'
import { ToastProvider, useToast } from './components/Toast'
import { cx } from './components/ui'
import { call } from './lib/api'
import { AuthProvider, useAuth } from './lib/auth'
import { PrefsProvider, SettingsProvider, usePrefs } from './lib/settings'
import { Lock } from './pages/auth/Lock'
import { RecoveredModal } from './pages/auth/RecoveredModal'
import { Setup } from './pages/auth/Setup'
import { Budgets } from './pages/Budgets'
import { ImportPage } from './pages/Import'
import { Overview } from './pages/Overview'
import { SettingsPage } from './pages/Settings'
import { NetWorthPage } from './pages/NetWorth'
import { RecurringPage } from './pages/Recurring'
import { GoalsPage } from './pages/Goals'
import { YearPage } from './pages/Year'
import { Transactions, type TxFilter } from './pages/Transactions'
import { showSetup } from '@shared/setup-rules'

export type Page = 'overview' | 'transactions' | 'budgets' | 'recurring' | 'goals' | 'year' | 'networth' | 'import' | 'settings'

const NAV: { page: Page; icon: ReactNode }[] = [
  { page: 'overview', icon: <LayoutDashboard size={17} /> },
  { page: 'transactions', icon: <ArrowLeftRight size={17} /> },
  { page: 'budgets', icon: <Target size={17} /> },
  { page: 'recurring', icon: <Repeat size={17} /> },
  { page: 'goals', icon: <PiggyBank size={17} /> },
  { page: 'year', icon: <CalendarRange size={17} /> },
  { page: 'networth', icon: <TrendingUp size={17} /> },
  { page: 'import', icon: <FileUp size={17} /> }
]

export function App() {
  return (
    <ToastProvider>
      <PrefsProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </PrefsProvider>
    </ToastProvider>
  )
}

function Gate() {
  const { status, setupFlowActive } = useAuth()
  // First screen is on display: the main process can swap the launch window for this one.
  useEffect(() => {
    void call('app.ready')
  }, [])
  if (showSetup(status.state, setupFlowActive)) return <Setup />
  if (status.state === 'locked') return <Lock />
  return (
    <SettingsProvider>
      <Main />
      <McpRequests />
      {(status.recovered || status.weakPassword) && <RecoveredModal weak={!status.recovered} />}
    </SettingsProvider>
  )
}

/** The welcome window comes first on a computer that hasn't seen it yet. */
function Main() {
  const { prefs } = usePrefs()
  return prefs.welcomeDone ? <Shell /> : <Welcome />
}

function Shell() {
  const { t } = useTranslation()
  const { info } = usePrefs()
  const { set } = useAuth()
  const toast = useToast()
  const [page, setPageState] = useState<Page>('overview')
  const [txFilter, setTxFilter] = useState<TxFilter | undefined>()
  const [navKey, setNavKey] = useState(0)
  const go = (p: Page, filter?: Record<string, unknown>): void => {
    setTxFilter(filter as TxFilter | undefined)
    setPageState(p)
    setNavKey((k) => k + 1)
  }
  const setPage = (p: Page): void => go(p)
  const [assistantOpen, setAssistantOpen] = useState(true)
  // Pages can ask for the assistant panel (e.g. "Review this month").
  useEffect(() => {
    const open = (): void => setAssistantOpen(true)
    window.addEventListener('kasboek:open-assistant', open)
    return () => window.removeEventListener('kasboek:open-assistant', open)
  }, [])
  const isMac = info.platform === 'darwin'

  useEffect(
    () =>
      window.kasboek.onEvent((e) => {
        if (e.type === 'backup.completed') toast(t('settings.backupSaved', { file: e.file }))
        if (e.type === 'backup.failed') toast(e.message, 'error')
      }),
    [toast, t]
  )

  const navItem = (p: Page, icon: ReactNode) => (
    <button
      key={p}
      type="button"
      data-tour={p}
      onClick={() => setPage(p)}
      aria-current={page === p ? 'page' : undefined}
      className={cx(
        'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
        page === p ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text'
      )}
    >
      {icon}
      {t(`nav.${p}`)}
    </button>
  )

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-bg">
        <div className={cx('drag flex h-11 items-center gap-2.5 px-5', isMac && 'mt-7')}>
          <Mark size={15} className="text-accent" />
          <span className="font-serif text-[17px] font-semibold tracking-[-0.01em]">{t('app.name')}</span>
        </div>
        <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-3">{NAV.map((n) => navItem(n.page, n.icon))}</nav>
        <div className="flex flex-col gap-0.5 px-3 pb-4">
          {navItem('settings', <SettingsIcon size={17} />)}
          <button
            type="button"
            data-tour="lock"
            onClick={() => void call('auth.lock').then(set)}
            className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <LockIcon size={17} />
            {t('nav.lock')}
          </button>
          {/* The version, quietly; a click opens "About Kasboek" in Settings. */}
          <button
            type="button"
            title={t('settings.about')}
            onClick={() => {
              openSettingsTab('about')
              setPage('settings')
            }}
            className="num mt-2 self-start rounded px-3 text-[11px] text-muted/70 transition-colors hover:text-text"
          >
            {t('app.versionShort', { version: info.version })}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className={cx('drag flex h-11 shrink-0 items-center justify-end', isMac ? 'pr-3' : 'pr-[148px]')}>
          <UpdateButton />
          <button
            type="button"
            data-tour="assistant"
            onClick={() => setAssistantOpen((v) => !v)}
            aria-pressed={assistantOpen}
            title={t('nav.toggleAssistant')}
            className={cx(
              'no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors',
              assistantOpen ? 'text-accent' : 'text-muted hover:text-text'
            )}
          >
            <PanelRight size={15} />
            {t('nav.assistant')}
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl px-10 pt-4 pb-16">
              {page === 'overview' && <Overview key={navKey} go={go} />}
              {page === 'transactions' && <Transactions key={navKey} go={setPage} initial={txFilter} />}
              {page === 'budgets' && <Budgets />}
              {page === 'year' && <YearPage key={navKey} />}
              {page === 'networth' && <NetWorthPage key={navKey} />}
              {page === 'recurring' && <RecurringPage key={navKey} />}
              {page === 'goals' && <GoalsPage key={navKey} />}
              {page === 'import' && <ImportPage go={setPage} />}
              {page === 'settings' && <SettingsPage key={navKey} />}
            </div>
          </main>
          {assistantOpen && <AssistantPanel go={setPage} />}
        </div>
      </div>
      <Tour go={setPage} openAssistant={() => setAssistantOpen(true)} />
    </div>
  )
}
