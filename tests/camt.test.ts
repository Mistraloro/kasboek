import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '@core/database'
import { openXmlSession } from '@core/camt/open'
import { centsOf, MAX_XML_BYTES, readCamt } from '@core/camt/read'
import { parseXml, XmlError } from '@core/camt/xml'
import { commit, remap } from '@core/import'
import { XML_ERROR_CODES, fileKindOf } from '@shared/pdf-import'

// All data here is invented. The IBANs are the published example numbers of the IBAN standard.
const OWN = 'BE68539007547034'
const OTHER = 'NL91ABNA0417164300'
const THIRD = 'DE89370400440532013000'
const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02'
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

interface Ntry {
  amt: string
  dir?: 'CRDT' | 'DBIT'
  booked?: string
  rvsl?: boolean
  date?: string
  value?: string
  inner?: string
  info?: string
  ccy?: string
}
const ntry = (e: Ntry): string =>
  `<Ntry><Amt Ccy="${e.ccy ?? 'EUR'}">${e.amt}</Amt><CdtDbtInd>${e.dir ?? 'DBIT'}</CdtDbtInd>${e.rvsl ? '<RvslInd>true</RvslInd>' : ''}<Sts>${e.booked ?? 'BOOK'}</Sts>` +
  `<BookgDt><Dt>${e.date ?? '2026-03-04'}</Dt></BookgDt><ValDt><Dt>${e.value ?? e.date ?? '2026-03-04'}</Dt></ValDt>${e.info ? `<AddtlNtryInf>${e.info}</AddtlNtryInf>` : ''}${e.inner ?? ''}</Ntry>`
const bal = (code: string, amt: string, dir: 'CRDT' | 'DBIT', date: string): string =>
  `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>${dir}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`
const stmt = (entries: string[], o: { iban?: string; bals?: string[]; tag?: string } = {}): string =>
  `<${o.tag ?? 'Stmt'}><Id>S1</Id><Acct><Id><IBAN>${o.iban ?? OWN}</IBAN></Id><Ccy>EUR</Ccy></Acct>${(o.bals ?? []).join('')}${entries.join('')}</${o.tag ?? 'Stmt'}>`
const doc = (body: string, ns = NS, wrap = 'BkToCstmrStmt'): string => `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${ns}"><${wrap}><GrpHdr><MsgId>M1</MsgId></GrpHdr>${body}</${wrap}></Document>`
const tx = (parts: string): string => `<NtryDtls><TxDtls>${parts}</TxDtls></NtryDtls>`
const payTo = (name: string, iban: string, text: string, refs = ''): string =>
  `<Refs>${refs}</Refs><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban}</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf>`

describe('xml reader', () => {
  it('builds a tree without namespace prefixes, with CDATA, character references and comments', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><ns2:A x="1 &amp; 2"><B><![CDATA[a < b]]></B><C>&#233;&#x20AC; &lt;&gt;</C><D/></ns2:A>')
    expect(root.name).toBe('A')
    expect(root.attrs.x).toBe('1 & 2')
    expect(root.children.map((c) => c.name)).toEqual(['B', 'C', 'D'])
    expect(root.children[0]!.text).toBe('a < b')
    expect(root.children[1]!.text).toBe('é€ <>')
  })
  it('refuses a DOCTYPE, however it is used', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>'
    const xxe = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>'
    for (const bad of [bomb, xxe]) expect(() => parseXml(bad)).toThrowError(expect.objectContaining({ failure: 'dtd' }))
  })
  it('refuses entities that are not built in', () => {
    expect(() => parseXml('<a>&x;</a>')).toThrowError(expect.objectContaining({ failure: 'broken' }))
    expect(() => parseXml('<a>&#0;</a>')).toThrowError(XmlError)
  })
  it('refuses malformed input', () => {
    for (const bad of ['', 'not xml', '<a>', '<a></b>', '<a><b></a></b>', '<a x=1/>', '<a x="1/>', '<a/><b/>', '<a>text</a>trailing', '<a><!-- open</a>', '<a><![CDATA[x</a>', '<a b></a>']) {
      expect(() => parseXml(bad), bad).toThrowError(XmlError)
    }
  })
  it('refuses absurd nesting without overflowing the stack', () => {
    expect(() => parseXml('<a>'.repeat(100_000))).toThrowError(expect.objectContaining({ failure: 'too_large' }))
  })
  it('reads a long flat file', () => {
    const root = parseXml(`<a>${'<b>1</b>'.repeat(50_000)}</a>`)
    expect(root.children).toHaveLength(50_000)
  })
})

describe('amounts', () => {
  it('converts text to cents exactly', () => {
    expect(centsOf('12.50')).toBe(1250)
    expect(centsOf('12')).toBe(1200)
    expect(centsOf('0.1')).toBe(10)
    expect(centsOf('1234567890123.45')).toBe(123456789012345)
    expect(centsOf('0.005')).toBe(1)
    expect(centsOf('-5')).toBeNull()
    expect(centsOf('1,5')).toBeNull()
    expect(centsOf('')).toBeNull()
    expect(centsOf('99999999999999999999')).toBeNull()
  })
})

describe('CAMT.053 entries', () => {
  it('reads one statement: account, balances, dates, signs, names and texts', () => {
    const xml = doc(
      stmt(
        [
          ntry({ amt: '45.10', dir: 'DBIT', date: '2026-03-04', value: '2026-03-05', inner: tx(payTo('Boulangerie Dupont', OTHER, 'Pain et croissants', '<AcctSvcrRef>REF-001</AcctSvcrRef><EndToEndId>NOTPROVIDED</EndToEndId>')) }),
          ntry({
            amt: '2500.00',
            dir: 'CRDT',
            date: '2026-03-05',
            inner: tx('<Refs><AcctSvcrRef>REF-002</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Werkgever Janssens BV</Nm></Dbtr><DbtrAcct><Id><IBAN>' + THIRD + '</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Ustrd>Loon maart</Ustrd></RmtInf>')
          })
        ],
        { bals: [bal('OPBD', '1000.00', 'CRDT', '2026-03-01'), bal('CLBD', '3454.90', 'CRDT', '2026-03-31'), bal('ITBD', '1.00', 'CRDT', '2026-03-10')] }
      )
    )
    const [s] = readCamt(bytes(xml)).statements
    expect(s).toMatchObject({ account: OWN, isIban: true, opening: 100000, closing: 345490, from: '2026-03-01', to: '2026-03-31', notBooked: 0 })
    expect(s!.rows).toEqual([
      { bookingDate: '2026-03-04', valueDate: '2026-03-05', amount: '-45.10', currency: 'EUR', counterparty: 'Boulangerie Dupont', counterpartyIban: OTHER, description: 'Pain et croissants', communication: '', reference: 'REF-001' },
      { bookingDate: '2026-03-05', valueDate: '2026-03-05', amount: '2500.00', currency: 'EUR', counterparty: 'Werkgever Janssens BV', counterpartyIban: THIRD, description: 'Loon maart', communication: '', reference: 'REF-002' }
    ])
  })

  it('takes a debit balance as negative, PRCD and CLAV as fallbacks', () => {
    const xml = doc(stmt([], { bals: [bal('PRCD', '80.00', 'DBIT', '2026-02-28'), bal('CLAV', '10.00', 'CRDT', '2026-03-31')] }))
    expect(readCamt(bytes(xml)).statements[0]).toMatchObject({ opening: -8000, closing: 1000 })
  })

  it('keeps the direction the file states for a reversal (RvslInd) and never guesses a missing one', () => {
    const xml = doc(stmt([ntry({ amt: '20.00', dir: 'CRDT', rvsl: true }), ntry({ amt: '7.00', dir: 'DBIT', rvsl: true }), ntry({ amt: '9.00', dir: undefined, inner: '' }).replace('<CdtDbtInd>DBIT</CdtDbtInd>', '')]))
    expect(readCamt(bytes(xml)).statements[0]!.rows.map((r) => r.amount)).toEqual(['20.00', '-7.00', ''])
  })

  it('leaves out entries that are not booked, and counts them', () => {
    const xml = doc(stmt([ntry({ amt: '1.00' }), ntry({ amt: '2.00', booked: 'PDNG' }), ntry({ amt: '3.00', booked: 'INFO' })]))
    const [s] = readCamt(bytes(xml)).statements
    expect(s!.rows).toHaveLength(1)
    expect(s!.notBooked).toBe(2)
  })

  it('reads the newer layout: Sts/Cd, Pty/Nm, DtTm dates', () => {
    const entry =
      `<Ntry><Amt Ccy="EUR">12.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><DtTm>2026-03-04T10:15:00+01:00</DtTm></BookgDt>` +
      tx('<RltdPties><Cdtr><Pty><Nm>Café Müller-Janssens</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>Déjeuner</Ustrd><Ustrd>à l’école</Ustrd></RmtInf>') +
      '</Ntry>'
    const row = readCamt(bytes(doc(stmt([entry]), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08'))).statements[0]!.rows[0]!
    expect(row).toMatchObject({ bookingDate: '2026-03-04', counterparty: 'Café Müller-Janssens', description: 'Déjeuner à l’école', amount: '-12.00' })
  })

  it('uses the creditor for money out and the debtor for money in, ultimate parties as a fallback', () => {
    const parties = '<RltdPties><Dbtr><Nm>Debtor Name</Nm></Dbtr><UltmtCdtr><Nm>Ultimate Creditor</Nm></UltmtCdtr></RltdPties>'
    const out = readCamt(bytes(doc(stmt([ntry({ amt: '1.00', dir: 'DBIT', inner: tx(parties) }), ntry({ amt: '1.00', dir: 'CRDT', inner: tx(parties) })])))).statements[0]!.rows
    expect(out.map((r) => r.counterparty)).toEqual(['Ultimate Creditor', 'Debtor Name'])
  })

  it('falls back to additional entry information, then to the bank transaction code', () => {
    const code = '<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn></BkTxCd>'
    const rows = readCamt(bytes(doc(stmt([ntry({ amt: '5.00', info: 'BETALING MET DEBETKAART Delhaize Gent' }), ntry({ amt: '6.00', inner: code })])))).statements[0]!.rows
    expect(rows[0]!.description).toBe('BETALING MET DEBETKAART Delhaize Gent')
    expect(rows[1]!.description).toBe('PMNT/CCRD/POSD')
  })

  it('reads a structured creditor reference as the communication', () => {
    const strd = tx('<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>+++090/9337/55493+++</Ref></CdtrRefInf><AddtlRmtInf>Factuur 2026-17</AddtlRmtInf></Strd></RmtInf>')
    const row = readCamt(bytes(doc(stmt([ntry({ amt: '9.00', inner: strd })])))).statements[0]!.rows[0]!
    expect(row.communication).toBe('+++090/9337/55493+++')
    expect(row.description).toBe('Factuur 2026-17')
  })

  it('uses an end-to-end id as a reference only together with the booking date', () => {
    const e2e = (date: string) => ntry({ amt: '700.00', date, inner: tx('<Refs><EndToEndId>RENT</EndToEndId></Refs>') })
    const rows = readCamt(bytes(doc(stmt([e2e('2026-03-01'), e2e('2026-04-01')])))).statements[0]!.rows
    expect(rows.map((r) => r.reference)).toEqual(['RENT 2026-03-01', 'RENT 2026-04-01'])
  })

  it('splits a batch into one row per transaction when the amounts add up', () => {
    const t = (name: string, amt: string, ref: string): string => `<TxDtls><Refs><EndToEndId>${ref}</EndToEndId></Refs><Amt Ccy="EUR">${amt}</Amt><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Salaris ${name}</Ustrd></RmtInf></TxDtls>`
    const batch = ntry({ amt: '300.50', inner: `<NtryDtls>${t('Anna', '100.25', 'E1')}${t('Bram', '200.25', 'E2')}</NtryDtls>`, info: 'Collectieve betaling' })
    const rows = readCamt(bytes(doc(stmt([batch])))).statements[0]!.rows
    expect(rows.map((r) => [r.counterparty, r.amount, r.description])).toEqual([
      ['Anna', '-100.25', 'Salaris Anna'],
      ['Bram', '-200.25', 'Salaris Bram']
    ])
  })

  it('keeps one row for the entry when a batch has no amounts, or they do not add up', () => {
    const t = (amt: string): string => `<TxDtls>${amt ? `<Amt Ccy="EUR">${amt}</Amt>` : ''}<RmtInf><Ustrd>Deel ${amt || 'x'}</Ustrd></RmtInf></TxDtls>`
    const none = ntry({ amt: '50.00', inner: `<NtryDtls>${t('')}${t('')}</NtryDtls>` })
    const off = ntry({ amt: '50.00', inner: `<NtryDtls>${t('10.00')}${t('20.00')}</NtryDtls>` })
    const rows = readCamt(bytes(doc(stmt([none, off])))).statements[0]!.rows
    expect(rows.map((r) => r.amount)).toEqual(['-50.00', '-50.00'])
    expect(rows[0]!.description).toBe('Deel x · Deel x')
  })

  it('reads big amounts exactly', () => {
    const rows = readCamt(bytes(doc(stmt([ntry({ amt: '9007199254740.99', dir: 'CRDT' }), ntry({ amt: '1234567.89' }), ntry({ amt: '99999999999999999.99' })])))).statements[0]!.rows
    expect(rows.map((r) => r.amount)).toEqual(['9007199254740.99', '-1234567.89', ''])
  })

  it('keeps the currency of each entry', () => {
    const rows = readCamt(bytes(doc(stmt([ntry({ amt: '3.00', ccy: 'USD' })])))).statements[0]!.rows
    expect(rows[0]!.currency).toBe('USD')
  })
})

describe('CAMT variants', () => {
  const entries = [ntry({ amt: '10.00', dir: 'CRDT' })]
  it('reads every namespace and prefix, and files without a namespace', () => {
    const variants = [
      doc(stmt(entries), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02'),
      doc(stmt(entries), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08'),
      doc(stmt(entries), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.13'),
      doc(stmt(entries), 'http://example.invalid/anything'),
      `<?xml version="1.0"?><c:Document xmlns:c="${NS}"><c:BkToCstmrStmt><c:Stmt><c:Acct><c:Id><c:IBAN>${OWN}</c:IBAN></c:Id></c:Acct>${entries[0]!.replace(/<(\/?)(\w)/g, '<$1c:$2')}</c:Stmt></c:BkToCstmrStmt></c:Document>`
    ]
    for (const v of variants) expect(readCamt(bytes(v)).statements[0]).toMatchObject({ account: OWN, rows: [{ amount: '10.00' }] })
  })
  it('reads CAMT.052 reports and CAMT.054 notifications as lists of entries', () => {
    const rpt = doc(stmt(entries, { tag: 'Rpt' }), 'urn:iso:std:iso:20022:tech:xsd:camt.052.001.08', 'BkToCstmrAcctRpt')
    const ntfctn = doc(stmt(entries, { tag: 'Ntfctn' }), 'urn:iso:std:iso:20022:tech:xsd:camt.054.001.02', 'BkToCstmrDbtCdtNtfctn')
    for (const v of [rpt, ntfctn]) expect(readCamt(bytes(v)).statements[0]!.rows).toHaveLength(1)
  })
  it('reads an account that has no IBAN from its other identification', () => {
    const xml = doc('<Stmt><Acct><Id><Othr><Id>123-4567890-12</Id></Othr></Id></Acct></Stmt>')
    expect(readCamt(bytes(xml)).statements[0]).toMatchObject({ account: '123-4567890-12', isIban: false })
  })
  it('decodes UTF-8 with a byte order mark, UTF-16 and a declared Latin-1', () => {
    const text = doc(stmt([ntry({ amt: '1.00', inner: tx('<RmtInf><Ustrd>Crème brûlée à Liège</Ustrd></RmtInf>') })]))
    const utf8bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(text)])
    const utf16 = new Uint8Array(2 + text.length * 2)
    utf16.set([0xff, 0xfe])
    for (let i = 0; i < text.length; i++) new DataView(utf16.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true)
    const latin1 = Uint8Array.from(Buffer.from(text.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), 'latin1'))
    for (const b of [utf8bom, utf16, latin1]) expect(readCamt(b).statements[0]!.rows[0]!.description).toBe('Crème brûlée à Liège')
  })
})

describe('refused files', () => {
  const code = (b: Uint8Array): string => {
    try {
      readCamt(b)
    } catch (e) {
      return (e as { code: string }).code
    }
    return 'accepted'
  }
  it('says what is wrong in plain codes', () => {
    expect(code(bytes('Date;Amount\n1;2'))).toBe('import.xml_broken')
    expect(code(new Uint8Array())).toBe('import.xml_broken')
    expect(code(bytes('<Document><Other/></Document>'))).toBe('import.xml_not_camt')
    expect(code(bytes(doc('', 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03')))).toBe('import.xml_not_camt')
    expect(code(bytes(doc(stmt([]), 'urn:iso:std:iso:20022:tech:xsd:camt.056.001.01')))).toBe('import.xml_not_camt')
    expect(code(bytes(doc(stmt([]), 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.99')))).toBe('import.xml_version')
    expect(code(bytes('<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "b">]>' + doc(stmt([]))))).toBe('import.xml_dtd')
    expect(code(new Uint8Array(MAX_XML_BYTES + 1))).toBe('import.xml_too_large')
    expect(code(bytes(doc(stmt([ntry({ amt: '1.00' })]).slice(0, -20))))).toBe('import.xml_broken')
  })
  it('refuses more than 50,000 entries', () => {
    expect(code(bytes(doc(stmt(Array.from({ length: 50_001 }, () => ntry({ amt: '1.00' }))))))).toBe('import.too_many')
  })
  it('has a text in every language for every error the screen words', () => {
    const dir = join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales')
    for (const lang of ['en', 'de', 'es', 'fr', 'nl', 'pt-PT']) {
      const errors = (JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8')) as { errors: Record<string, string> }).errors
      for (const c of XML_ERROR_CODES) expect(errors[c.replace('.', '_')], `${lang} ${c}`).toBeTruthy()
    }
  })
})

describe('XML import session', () => {
  function setup() {
    const d = openDatabase(join(mkdtempSync(join(tmpdir(), 'kb-camt-')), 'k.db'), randomBytes(32).toString('hex'))
    const own = Number(d.prepare("INSERT INTO accounts (name, iban) VALUES ('Main', ?)").run(OWN).lastInsertRowid)
    const plain = Number(d.prepare("INSERT INTO accounts (name) VALUES ('No IBAN')").run().lastInsertRowid)
    return { d, own, plain }
  }
  const file = (extra: string[] = []): string =>
    doc(
      stmt(
        [
          ntry({ amt: '45.10', dir: 'DBIT', date: '2026-03-04', inner: tx(payTo('Boulangerie Dupont', OTHER, 'Pain', '<AcctSvcrRef>REF-001</AcctSvcrRef>')) }),
          ntry({ amt: '2500.00', dir: 'CRDT', date: '2026-03-05', inner: tx('<Refs><AcctSvcrRef>REF-002</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Werkgever Janssens BV</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Loon</Ustrd></RmtInf>') }),
          ntry({ amt: '9.99', dir: 'DBIT', date: '2026-03-06', ccy: 'USD', inner: tx('<Refs><AcctSvcrRef>REF-003</AcctSvcrRef></Refs><RmtInf><Ustrd>Online abonnement</Ustrd></RmtInf>') })
        ],
        { bals: [bal('OPBD', '1000.00', 'CRDT', '2026-03-01'), bal('CLBD', '3454.90', 'CRDT', '2026-03-31')] }
      ) + extra.join('')
    )

  it('gives the same preview as a CSV import: rows, signs, totals, a reconciliation, other currency flagged', () => {
    const { d, own } = setup()
    const p = openXmlSession(d, { fileName: 'statement.xml', accountId: own, bytes: bytes(file()) })
    expect(p.fileKind).toBe('xml')
    expect(p.pdf).toBeNull()
    expect(p.mappingSource).toBe('detected')
    expect(p.rows.map((r) => [r.bookingDate, r.amountCents, r.counterpartyName, r.description])).toEqual([
      ['2026-03-04', -4510, 'Boulangerie Dupont', 'Pain'],
      ['2026-03-05', 250000, 'Werkgever Janssens BV', 'Loon'],
      ['2026-03-06', -999, null, 'Online abonnement']
    ])
    expect(p.rows[0]!.counterpartyIban).toBe(OTHER)
    expect(p.rows[2]!.issues).toContain('currency_other')
    expect(p.stats).toMatchObject({ total: 3, ready: 3, inCents: 250000, outCents: 5509 })
    // 1000.00 - 45.10 + 2500.00 - 9.99 = 3444.91, the file says 3454.90: the banner shows the gap.
    expect(p.xml!.reconciliation).toMatchObject({ openingCents: 100000, closingCents: 345490, sumCents: 244491, differenceCents: 999 })
    expect(p.xml!.notes).toEqual([])
  })

  it('reconciles when the rows add up', () => {
    const { d, own } = setup()
    const xml = doc(stmt([ntry({ amt: '40.00' }), ntry({ amt: '15.50', dir: 'CRDT' })], { bals: [bal('OPBD', '100.00', 'CRDT', '2026-03-01'), bal('CLBD', '75.50', 'CRDT', '2026-03-31')] }))
    const p = openXmlSession(d, { fileName: 'a.xml', accountId: own, bytes: bytes(xml) })
    expect(p.xml!.reconciliation).toMatchObject({ differenceCents: 0 })
  })

  it('imports, records the closing balance, and sees the same file again as duplicates', () => {
    const { d, own } = setup()
    const xml = bytes(file())
    const first = openXmlSession(d, { fileName: 's.xml', accountId: own, bytes: xml })
    const done = commit(d, first.sessionId, true)
    expect(done.imported).toBe(3)
    expect(done.bankBalance).toMatchObject({ date: '2026-03-31', balanceCents: 345490 })
    const again = openXmlSession(d, { fileName: 's.xml', accountId: own, bytes: xml })
    expect(again.stats).toMatchObject({ duplicates: 3, ready: 0 })
  })

  it('lets the columns be changed and the signs flipped like any import', () => {
    const { d, own } = setup()
    const p = openXmlSession(d, { fileName: 's.xml', accountId: own, bytes: bytes(file()) })
    expect(p.mapping!.invertSign).toBe(false)
    const flipped = remap(d, p.sessionId, { ...p.mapping!, invertSign: true })
    expect(flipped.rows.map((r) => r.amountCents)).toEqual([4510, -250000, 999])
    // Opposite signs no longer add up to the balances, which the banner shows.
    expect(flipped.xml!.reconciliation!.differenceCents).not.toBe(0)
  })

  it('picks the statements of the chosen account from a file with several', () => {
    const { d, own } = setup()
    const xml = doc(stmt([ntry({ amt: '1.00' })]) + stmt([ntry({ amt: '2.00' }), ntry({ amt: '3.00' })], { iban: OTHER }) + stmt([ntry({ amt: '4.00' })], { iban: OWN }))
    const p = openXmlSession(d, { fileName: 'm.xml', accountId: own, bytes: bytes(xml) })
    expect(p.rows.map((r) => r.amountCents)).toEqual([-100, -400])
    expect(p.xml!.notes).toEqual([{ code: 'accounts_left_out', count: 1 }])
  })

  it('uses the statements of the first of two for opening and the last for closing, in date order', () => {
    const { d, own } = setup()
    const march = stmt([ntry({ amt: '10.00', date: '2026-03-10' })], { bals: [bal('OPBD', '100.00', 'CRDT', '2026-03-01'), bal('CLBD', '90.00', 'CRDT', '2026-03-31')] })
    const april = stmt([ntry({ amt: '5.00', date: '2026-04-10' })], { bals: [bal('OPBD', '90.00', 'CRDT', '2026-04-01'), bal('CLBD', '85.00', 'CRDT', '2026-04-30')] })
    const p = openXmlSession(d, { fileName: 'm.xml', accountId: own, bytes: bytes(doc(april + march)) })
    expect(p.xml!.reconciliation).toMatchObject({ openingCents: 10000, closingCents: 8500, differenceCents: 0 })
  })

  it('notes a file for another account, and refuses several accounts none of which is the chosen one', () => {
    const { d, own, plain } = setup()
    const other = doc(stmt([ntry({ amt: '1.00' })], { iban: OTHER }))
    expect(openXmlSession(d, { fileName: 'o.xml', accountId: own, bytes: bytes(other) }).xml!.notes).toEqual([{ code: 'other_account', iban: 'NL…4300' }])
    expect(openXmlSession(d, { fileName: 'o.xml', accountId: plain, bytes: bytes(other) }).xml!.notes).toEqual([])
    const several = doc(stmt([ntry({ amt: '1.00' })], { iban: OTHER }) + stmt([ntry({ amt: '1.00' })], { iban: THIRD }))
    expect(() => openXmlSession(d, { fileName: 'x.xml', accountId: own, bytes: bytes(several) })).toThrowError(expect.objectContaining({ code: 'import.xml_accounts' }))
  })

  it('reports not booked entries and an empty file', () => {
    const { d, own } = setup()
    const p = openXmlSession(d, { fileName: 'p.xml', accountId: own, bytes: bytes(doc(stmt([ntry({ amt: '1.00' }), ntry({ amt: '2.00', booked: 'PDNG' })]))) })
    expect(p.xml!.notes).toEqual([{ code: 'not_booked', count: 1 }])
    expect(() => openXmlSession(d, { fileName: 'e.xml', accountId: own, bytes: bytes(doc(stmt([]))) })).toThrowError(expect.objectContaining({ code: 'import.empty' }))
  })

  it('flags a missing credit/debit indicator as a problem instead of guessing', () => {
    const { d, own } = setup()
    const noDir = ntry({ amt: '5.00' }).replace('<CdtDbtInd>DBIT</CdtDbtInd>', '')
    const p = openXmlSession(d, { fileName: 'n.xml', accountId: own, bytes: bytes(doc(stmt([noDir]))) })
    expect(p.rows[0]).toMatchObject({ status: 'problem', amountCents: null })
  })
})

describe('file kind', () => {
  it('recognises XML by its first character, with a byte order mark or spaces', () => {
    expect(fileKindOf(bytes('<?xml version="1.0"?>'))).toBe('xml')
    expect(fileKindOf(bytes('\n  <Document>'))).toBe('xml')
    expect(fileKindOf(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('<?xml')]))).toBe('xml')
    expect(fileKindOf(new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x3f, 0x00]))).toBe('xml')
    expect(fileKindOf(new Uint8Array([0xfe, 0xff, 0x00, 0x3c, 0x00, 0x3f]))).toBe('xml')
    expect(fileKindOf(new Uint8Array([0x3c, 0x00, 0x3f, 0x00]))).toBe('xml')
  })
  it('keeps text exports as CSV', () => {
    expect(fileKindOf(bytes('Date;Amount'))).toBe('csv')
    expect(fileKindOf(bytes('   '))).toBe('csv')
    expect(fileKindOf(bytes('%PDF-1.4'))).toBe('pdf')
  })
})
