import { ArrowLeftRight, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Page } from '../App'
import { Button, Card, EmptyState, Input, PageHeader } from '../components/ui'

export function Transactions({ go }: { go: (p: Page) => void }) {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('transactions.title')} subtitle={t('transactions.subtitle')} />
      <div className="relative mb-4 max-w-sm">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
        <Input placeholder={t('transactions.search')} className="pl-9" disabled aria-label={t('transactions.search')} />
      </div>
      <Card>
        <EmptyState
          icon={<ArrowLeftRight size={20} />}
          title={t('transactions.emptyTitle')}
          body={t('transactions.emptyBody')}
          action={
            <Button variant="primary" onClick={() => go('import')}>
              {t('transactions.goImport')}
            </Button>
          }
        />
      </Card>
    </>
  )
}
