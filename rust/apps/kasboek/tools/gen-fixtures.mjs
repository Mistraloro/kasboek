// Writes fixtures/household.json from the invented household of the release screenshots (scripts/screenshots/data.mjs on
// branch claude/focused-pasteur-oeugzy). Run:
//   git show claude/focused-pasteur-oeugzy:scripts/screenshots/data.mjs > /tmp/data.mjs
//   node rust/apps/kasboek/tools/gen-fixtures.mjs /tmp/data.mjs
// The answers of operations the app uses, the month summaries and the budgets. Transactions are left out (no screen shows them yet).
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const { buildData } = await import(pathToFileURL(process.argv[2]).href)
const d = buildData()
const keep = ['app.info', 'prefs.get', 'auth.status', 'settings.get', 'backup.status', 'accounts.list', 'categories.list', 'alerts.list', 'recurring.list', 'goals.list', 'networth.summary', 'insights.get', 'insights.status', 'assistant.status', 'update.status']
const answers = Object.fromEntries(keep.map((k) => [k, d.answers[k]]))
// The fixture speaks for this version of the app.
answers['app.info'] = { ...answers['app.info'], version: '0.22.0' }
// The assistant is configured in the release screenshots; the chat history is not needed here.
answers['assistant.status'] = { ...answers['assistant.status'], messages: [] }
// What the assistant would be sent for the month, as `insights.preview` writes it: facts only, rounded amounts, no account numbers.
const facts = d.answers['insights.get'].facts
answers['insights.preview'] = {
  text: ['Month: 2026-11', ...facts.map((f) => `${f.id} ${f.kind}: ` + Object.entries(f.values).map(([k, v]) => `${k}=${'money' in v ? Math.round(v.money / 100) + ' ' + v.currency : 'count' in v ? v.count : 'date' in v ? v.date : v.text}`).join(', '))].join('\n')
}
writeFileSync(new URL('../fixtures/household.json', import.meta.url), JSON.stringify({ today: d.today, answers, summaryMonth: d.summaryMonth, budgets: d.budgets }) + '\n')
console.log('written', Object.keys(d.summaryMonth).length, 'months')
