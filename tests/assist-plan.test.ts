import { describe, expect, it } from 'vitest'
import { groupKey, parsePlan, rowGroups } from '@core/assist-plan'

const row = (index: number, counterpartyName: string | null, description: string, amountCents: number, categoryId: number | null = null) =>
  ({ index, counterpartyName, description, amountCents, categoryId, status: 'ready' }) as never

describe('CSV check plan', () => {
  it('groups the same shop across dates, card numbers and references, by direction', () => {
    expect(groupKey(row(0, null, 'Bancontact DELHAIZE LEUVEN 03/10 12:34 kaart 4871', -4560))).toBe(groupKey(row(1, null, 'BANCONTACT Delhaize Leuven 17/10 18:02 kaart 4871', -1200)))
    expect(groupKey(row(0, 'Engie Electrabel', 'Domiciliëring 123', -12450))).not.toBe(groupKey(row(1, 'Engie Electrabel', 'Terugbetaling', 5000)))
    const groups = rowGroups([
      row(0, 'Colruyt', 'a', -100),
      row(1, 'Colruyt', 'b', -200),
      row(2, 'NMBS', 'c', -300),
      row(3, 'Colruyt', 'd', -400, 7)
    ])
    expect(groups.map((g) => [g.example.counterpartyName, g.rows.length])).toEqual([
      ['Colruyt', 3],
      ['NMBS', 1]
    ])
  })

  it('reads answers with numbers as text, code fences and one bad entry', () => {
    const text = '```json\n' + JSON.stringify({
      mapping: null,
      fixes: [{ index: '3', action: 'skip', bookingDate: null, amountCents: null, description: null, reason: 'total line' }, { index: 'x', action: 'skip' }],
      groups: [{ group: '0', categoryId: '5', name: 'Colruyt', description: null }, { group: 1, categoryId: 6 }, { name: 'no group' }],
      notes: ['Checked.', 42]
    }) + '\n```'
    const plan = parsePlan(text, 'Mistral')
    expect(plan.fixes).toEqual([{ index: 3, action: 'skip', bookingDate: null, amountCents: null, description: null, reason: 'total line' }])
    expect(plan.groups).toEqual([{ group: 0, categoryId: 5, name: 'Colruyt', description: null }, { group: 1, categoryId: 6, name: null, description: null }])
    expect(plan.notes).toEqual(['Checked.'])
  })

  it('keeps a date as a date, and column numbers as numbers', () => {
    const plan = parsePlan(JSON.stringify({ mapping: { headerRow: '0', dateOrder: 'DMY', decimal: ',', invertSign: false, columns: { bookingDate: '1', amount: '3', valueDate: null, debit: null, credit: null, currency: null, counterpartyName: '5', counterpartyIban: null, communication: null, bankReference: null, status: null, description: ['6', '7'] } }, fixes: [{ index: 2, action: 'fix', bookingDate: '2026-11-03', amountCents: '-1250', description: null, reason: 'date' }], groups: [], notes: [] }), 'X')
    expect(plan.mapping?.columns.bookingDate).toBe(1)
    expect(plan.mapping?.columns.description).toEqual([6, 7])
    expect(plan.fixes[0]).toMatchObject({ bookingDate: '2026-11-03', amountCents: -1250 })
  })

  it('refuses an answer with nothing usable', () => {
    expect(() => parsePlan('not json', 'Mistral')).toThrow(/couldn’t be read/)
    expect(() => parsePlan('{"foo":1}', 'Mistral')).toThrow(/couldn’t be read/)
  })
})
