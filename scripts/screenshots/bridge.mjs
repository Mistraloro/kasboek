// The stand-in for the preload bridge (`window.kasboek`), installed in the page before the app starts.
// It answers the operations of src/shared/contract.ts from the invented household in data.mjs and
// from the scenario of one screenshot. It runs inside the browser: playwright sends this function as
// text, so it must not use anything from outside itself.
export function installBridge({ data, scenario }) {
  const answers = structuredClone(data.answers)
  Object.assign(answers['prefs.get'], { theme: scenario.theme })
  Object.assign(answers['auth.status'], scenario.auth ?? {})
  if (scenario.import) answers['import.current'] = data.imports[scenario.import]

  const monthOf = (date) => date.slice(0, 7)
  const listTransactions = (f) => {
    const q = f.search?.trim().toLowerCase()
    const rows = data.transactions.filter(
      (x) =>
        (!f.accountId || x.accountId === f.accountId) &&
        (f.categoryId === undefined || (f.categoryId === 'none' ? x.categoryId === null : x.categoryId === f.categoryId)) &&
        (!f.month || monthOf(x.bookingDate) === f.month) &&
        (!f.from || x.bookingDate >= f.from) &&
        (!f.to || x.bookingDate <= f.to) &&
        (f.direction !== 'in' || x.amountCents > 0) &&
        (f.direction !== 'out' || x.amountCents < 0) &&
        (!q || `${x.description} ${x.counterpartyName ?? ''}`.toLowerCase().includes(q))
    )
    const sum = (list) => list.reduce((a, x) => a + x.amountCents, 0)
    return {
      items: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100)),
      total: rows.length,
      inCents: sum(rows.filter((x) => x.amountCents > 0)),
      outCents: -sum(rows.filter((x) => x.amountCents < 0))
    }
  }

  const answer = (op, input) => {
    switch (op) {
      case 'transactions.list':
        return listTransactions(input)
      case 'summary.month':
        return data.summaryMonth[input.month]
      case 'budgets.list':
        return data.budgets[input.month]
      case 'summary.year':
        return data.yearSummary[input.year]
      case 'transactions.splits':
        return []
      default:
        if (op in answers) return answers[op]
        throw new Error(`no fixture for ${op}`)
    }
  }

  window.kasboek = {
    invoke: async (op, input) => {
      try {
        return { ok: true, data: structuredClone(answer(op, input ?? {})) }
      } catch (e) {
        // Anything the pictures do not need stays quiet: an operation without a fixture just says OK.
        console.warn('[bridge]', op, String(e))
        return { ok: true, data: { ok: true } }
      }
    },
    onEvent: () => () => {}
  }
}
