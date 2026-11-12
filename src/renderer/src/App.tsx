import { ArrowLeftRight, FileUp, LayoutDashboard, Lock as LockIcon, PanelRight, Settings as SettingsIcon, Target } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AssistantPanel } from './components/AssistantPanel'
import { Mark } from './components/Mark'
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
import { Transactions } from './pages/Transactions'

export type Page = 'overview' | 'transactions' | 'budgets' | 'import' | 'settings'

const NAV: { page: Page; icon: ReactNode }[] = [
  { page: 'overview', icon: <LayoutDashboard size={17} /> },
  { page: 'transactions', icon: <ArrowLeftRight size={17} /> },
  { page: 'budgets', icon: <Target size={17} /> },
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
  const { status } = useAuth()
  if (status.state === 'setup') return <Setup />
  if (status.state === 'locked') return <Lock />
  return (
    <SettingsProvider>
      <Shell />
      {status.recovered && <RecoveredModal />}
    </SettingsProvider>
  )
}

function Shell() {
  const { t } = useTranslation()
  const { info } = usePrefs()
  const { set } = useAuth()
  const toast = useToast()
  const [page, setPage] = useState<Page>('overview')
  const [assistantOpen, setAssistantOpen] = useState(true)
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
            onClick={() => void call('auth.lock').then(set)}
            className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <LockIcon size={17} />
            {t('nav.lock')}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className={cx('drag flex h-11 shrink-0 items-center justify-end', isMac ? 'pr-3' : 'pr-[148px]')}>
          <button
            type="button"
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
              {page === 'overview' && <Overview go={setPage} />}
              {page === 'transactions' && <Transactions go={setPage} />}
              {page === 'budgets' && <Budgets />}
              {page === 'import' && <ImportPage />}
              {page === 'settings' && <SettingsPage />}
            </div>
          </main>
          {assistantOpen && <AssistantPanel />}
        </div>
      </div>
    </div>
  )
}
