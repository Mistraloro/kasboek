import { FileUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Card, EmptyState, PageHeader } from '../components/ui'

const SUPPORTED = ['argenta', 'hellobank', 'keytrade'] as const

export function ImportPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('import.title')} subtitle={t('import.subtitle')} />
      <Card className="border-dashed">
        <EmptyState icon={<FileUp size={20} />} title={t('import.dropTitle')} body={t('import.dropBody')} />
      </Card>
      <div className="mt-6">
        <p className="mb-2 text-[13px] font-medium text-muted">{t('import.supported')}</p>
        <div className="flex gap-2">
          {SUPPORTED.map((b) => (
            <Badge key={b}>{t(`banks.${b}`)}</Badge>
          ))}
        </div>
      </div>
    </>
  )
}
