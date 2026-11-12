import { useTranslation } from 'react-i18next'
import { Card, PageHeader } from '../components/ui'
import { useOp } from '../lib/api'
import { monthLabel } from '../lib/format'
import { useSettings } from '../lib/settings'

export function Budgets() {
  const { t } = useTranslation()
  const { settings, money } = useSettings()
  const categories = useOp('categories.list')
  const expense = (categories.data ?? []).filter((c) => c.kind === 'expense' && !c.archived)

  return (
    <>
      <PageHeader title={t('budgets.title')} subtitle={monthLabel(new Date(), settings.formatLocale)} />
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[12px] text-muted">
              <th className="px-5 py-3 font-medium">{t('budgets.category')}</th>
              <th className="px-5 py-3 text-right font-medium">{t('budgets.budget')}</th>
              <th className="px-5 py-3 text-right font-medium">{t('budgets.spent')}</th>
              <th className="w-56 px-5 py-3 font-medium">{t('budgets.remaining')}</th>
            </tr>
          </thead>
          <tbody>
            {expense.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-b-0">
                <td className="px-5 py-3 font-medium">{c.name}</td>
                <td className="px-5 py-3 text-right text-muted">{t('budgets.notSet')}</td>
                <td className="num px-5 py-3 text-right">{money(0)}</td>
                <td className="px-5 py-3">
                  <div className="h-1.5 w-full rounded-full bg-surface-2" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="mt-3 text-xs text-muted">{t('budgets.hint')}</p>
    </>
  )
}
