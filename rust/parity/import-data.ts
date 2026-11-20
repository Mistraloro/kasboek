// Invented bank files for the import scenarios: CSV in several layouts and encodings, and CAMT XML (the builders of
// tests/camt.test.ts, extended). Names, IBANs and amounts are made up; the IBANs are the published examples of the standard.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const OWN = 'BE68539007547034'
export const OTHER = 'NL91ABNA0417164300'
export const THIRD = 'DE89370400440532013000'
export const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02'

export const fixture = (name: string): Buffer => readFileSync(resolve(import.meta.dirname, '../../tests/fixtures', name))
export const b64 = (data: string | Uint8Array): string => Buffer.from(typeof data === 'string' ? data : data).toString('base64')

/** mulberry32: a small seeded generator. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ----------------------------------------------------------------------------------------------------- text to bytes

export const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')
export const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')
export const utf8bom = (s: string): Buffer => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])
export const utf16le = (s: string, bom = true): Buffer => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')])
export const utf16be = (s: string, bom = true): Buffer => {
  const le = Buffer.from(s, 'utf16le')
  for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!]
  return Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), le])
}

/** Rows to CSV text: a field is quoted when it holds the delimiter, a quote or a line break. */
export function csv(rows: string[][], delimiter = ';', eol = '\n'): string {
  const field = (f: string): string => (f.includes(delimiter) || f.includes('"') || f.includes('\n') || f.includes('\r') ? `"${f.replaceAll('"', '""')}"` : f)
  return rows.map((r) => r.map(field).join(delimiter)).join(eol) + eol
}

// ----------------------------------------------------------------------------------------------------- CSV files

/** A Belgian export (semicolons, dd-mm-yyyy, comma decimals, thousands dots) in Windows-1252. */
export const belgian = (): Buffer =>
  latin1(
    csv([
      ['Nr v/d rekening', 'Boekdatum', 'Valuta', 'Referentie', 'Beschrijving', 'Bedrag', 'Munt', 'Rekening tegenpartij', 'Naam tegenpartij', 'Mededeling'],
      ['BE68 5390 0754 7034', '03-10-2026', '03-10-2026', 'REF0001', 'Betaling Bancontact', '-45,60', 'EUR', '', 'DELHAIZE GENT', ''],
      ['BE68 5390 0754 7034', '01-10-2026', '01-10-2026', 'REF0002', 'Overschrijving', '2.850,00', 'EUR', 'BE71 0961 2345 6769', 'ACME NV', 'Loon september'],
      ['BE68 5390 0754 7034', '05-10-2026', '05-10-2026', 'REF0003', 'Domiciliëring', '-124,50', 'EUR', 'BE45 0017 0000 0089', 'ENGIE', '+++090/9337/55493+++'],
      ['BE68 5390 0754 7034', '07-10-2026', '07-10-2026', 'REF0004', 'Betaling Bancontact', '-12,00', 'EUR', '', 'CAFÉ DE ZWAAN', '']
    ])
  )

export const commaIso = (): string =>
  csv(
    [
      ['Date', 'Description', 'Amount'],
      ['2026-03-01', 'Coffee beans', '-12.50'],
      ['2026-03-02', 'Salary March', '2500.00'],
      ['2026-03-04', 'Train ticket', '-23.40'],
      ['2026-03-05', 'Refund shop', '19.99']
    ],
    ','
  )

export const tabbed = (): string =>
  csv(
    [
      ['Datum', 'Omschrijving', 'Bedrag'],
      ['03/11/2026', 'Brood en gebak', '-8,40'],
      ['04/11/2026', 'Storting', '150,00'],
      ['05/11/2026', 'Tankstation', '-61,25']
    ],
    '\t'
  )

export const piped = (): string =>
  csv(
    [
      ['Date', 'Payee', 'Amount'],
      ['11/03/2026', 'Bakery Sunrise', '-4.25'],
      ['11/28/2026', 'Freelance job', '1,200.00'],
      ['11/29/2026', 'Hardware store', '-89.99']
    ],
    '|'
  )

/** ING Netherlands style: YYYYMMDD, Af/Bij, comma decimals, thousands dot in the balance. */
export const dutchIng = (): string =>
  csv([
    ['Datum', 'Naam / Omschrijving', 'Rekening', 'Tegenrekening', 'Code', 'Af Bij', 'Bedrag (EUR)', 'Mutatiesoort', 'Mededelingen', 'Saldo na mutatie', 'Tag'],
    ['20261103', 'Albert Heijn 1234', 'NL20INGB0001234567', '', 'BA', 'Af', '23,45', 'Betaalautomaat', 'Pasvolgnr: 001', '1.000,00', ''],
    ['20261105', 'Werkgever BV', 'NL20INGB0001234567', 'NL91ABNA0417164300', 'OV', 'Bij', '2.500,00', 'Overschrijving', 'Salaris november', '3.500,00', ''],
    ['20261106', 'Gemeente Utrecht', 'NL20INGB0001234567', 'NL91ABNA0417164300', 'IC', 'Af', '150,00', 'Incasso', 'Afvalstoffenheffing', '3.350,00', '']
  ])

/** Sparkasse style: every field quoted, dd.mm.yy, umlauts, Latin-1. */
export const germanSparkasse = (): Buffer => {
  const rows = [
    ['Auftragskonto', 'Buchungstag', 'Valutadatum', 'Buchungstext', 'Verwendungszweck', 'Beguenstigter/Zahlungspflichtiger', 'Kontonummer/IBAN', 'Betrag', 'Waehrung', 'Info'],
    ['DE12500105170648489890', '03.11.26', '03.11.26', 'KARTENZAHLUNG', 'EDEKA Müller', 'EDEKA Center', 'DE44500105175407324931', '-15,99', 'EUR', 'Umsatz gebucht'],
    ['DE12500105170648489890', '05.11.26', '05.11.26', 'GUTSCHR. ÜBERWEISUNG', 'Miete für Wohnung', 'Max Mustermann', 'DE89370400440532013000', '650,00', 'EUR', 'Umsatz gebucht'],
    ['DE12500105170648489890', '06.11.26', '06.11.26', 'LASTSCHRIFT', 'Strom Nov', 'Stadtwerke', 'DE02120300000000202051', '-1.234,56', 'EUR', 'Umsatz gebucht']
  ]
  return latin1(rows.map((r) => r.map((f) => `"${f}"`).join(';')).join('\n') + '\n')
}

/** French style: separate Débit and Crédit columns, spaces and no-break spaces as thousands marks. */
export const french = (): string =>
  csv([
    ['Date opération', 'Libellé', 'Débit', 'Crédit', 'Solde'],
    ['03/11/2026', 'CB BOULANGERIE PAUL', '4,50', '', '1 245,50'],
    ['04/11/2026', 'VIR SALAIRE ACME', '', '2 150,00', '3 395,50'],
    ['05/11/2026', 'PRLV LOYER', '1 050,00', '', '2 345,50']
  ])

/** Revolut style: ISO date-times, one currency column, a balance column. */
export const revolutLike = (): string =>
  csv(
    [
      ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'],
      ['CARD_PAYMENT', 'Current', '2026-11-03 10:15:02', '2026-11-04 09:01:33', 'Spotify', '-10.99', '0.00', 'EUR', 'COMPLETED', '489.01'],
      ['TOPUP', 'Current', '2026-11-05 12:00:00', '2026-11-05 12:00:01', 'Top-Up by *1234', '200.00', '0.00', 'EUR', 'COMPLETED', '689.01'],
      ['CARD_PAYMENT', 'Current', '2026-11-06 08:00:00', '2026-11-06 08:00:09', 'Hotel Lisboa', '-80.00', '0.00', 'USD', 'COMPLETED', '609.01'],
      ['CARD_PAYMENT', 'Current', '2026-11-07 08:00:00', '2026-11-07 08:00:09', 'Cancelled order', '-5.00', '0.00', 'EUR', 'CANCELLED', '609.01']
    ],
    ','
  )

/** Bank-specific headers of tests/banks.test.ts: one payment out and one in each. */
export const BANK_FILES: Record<string, string> = {
  rabobank:
    '"IBAN/BBAN","Munt","BIC","Volgnr","Datum","Rentedatum","Bedrag","Saldo na trn","Tegenrekening IBAN/BBAN","Naam tegenpartij","Naam uiteindelijke partij","Naam initiërende partij","BIC tegenpartij","Code","Batch ID","Transactiereferentie","Machtigingskenmerk","Incassant ID","Betalingskenmerk","Omschrijving-1","Omschrijving-2","Omschrijving-3"\n"NL11RABO0123456789","EUR","RABONL2U","000000000000001234","2026-11-03","2026-11-03","-12,50","987,50","NL91ABNA0417164300","Jumbo","","","","bc","","","","","","Jumbo Utrecht","",""\n"NL11RABO0123456789","EUR","RABONL2U","000000000000001235","2026-11-04","2026-11-04","+100,00","1087,50","NL91ABNA0417164300","J. Jansen","","","","tb","","","","","","Terugbetaling","",""',
  kbc: 'Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling\nBE68539007547034;Zichtrekening;JAN PEETERS;EUR;2026011;03/11/2026;BETALING DELHAIZE;03/11/2026;-45,10;954,90;;45,10;;;DELHAIZE;;;\nBE68539007547034;Zichtrekening;JAN PEETERS;EUR;2026011;05/11/2026;OVERSCHRIJVING;05/11/2026;1.200,00;2.154,90;1.200,00;;BE71096123456769;GKCCBEBB;WERKGEVER NV;;;Loon',
  belfius:
    'Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen\nBE68539007547034;03/11/2026;11;1001;;COLRUYT;;;Betaling met kaart;03/11/2026;-30,00;EUR;;BE;\nBE68539007547034;06/11/2026;11;1002;BE71096123456769;PEETERS;;;Overschrijving;06/11/2026;50,00;EUR;GKCCBEBB;BE;Etentje',
  deutscheBank:
    'Buchungstag;Wert;Umsatzart;Begünstigter / Auftraggeber;Verwendungszweck;IBAN;BIC;Kundenreferenz;Mandatsreferenz ;Gläubiger ID;Fremde Gebühren;Betrag;Abweichender Empfänger;Anzahl der Aufträge;Anzahl der Schecks;Soll;Haben;Währung\n03.11.2026;03.11.2026;Kartenzahlung;REWE Markt;REWE SAGT DANKE;;;;;;;;;;;-27,80;;EUR\n05.11.2026;05.11.2026;Gutschrift;Arbeitgeber GmbH;Gehalt November;DE89370400440532013000;COBADEFFXXX;;;;;;;;;;3.100,00;EUR',
  n26: '"Booking Date","Value Date","Partner Name","Partner Iban","Type","Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"\n"2026-11-03","2026-11-03","Lidl","","Presentment","","Main Account","-8.49","","",""\n"2026-11-05","2026-11-05","Anna Schmidt","DE89370400440532013000","Credit Transfer","Rent share","Main Account","400.00","","",""',
  wise: '"TransferWise ID",Date,Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees"\nCARD-123,03-11-2026,-25.00,EUR,"Card transaction of 25.00 EUR issued by Bol.com",,475.00,,,,,,,Bol.com,1234,"J PEETERS",,,0.00\nTRANSFER-456,05-11-2026,300.00,EUR,"Received money from J Peeters",,775.00,,,,"J Peeters",,,,,,,,0.00',
  chase: 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,11/03/2026,"COFFEE HOUSE 123",-4.50,DEBIT_CARD,1295.50,\nCREDIT,11/05/2026,"PAYROLL ACME",1500.00,ACH_CREDIT,2795.50,',
  lloyds: 'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n03/11/2026,DEB,\'11-22-33,12345678,TESCO STORES,23.10,,1000.00\n05/11/2026,FPI,\'11-22-33,12345678,SALARY ACME,,1800.00,2800.00',
  monzo: 'Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split\ntx_1,03/11/2026,10:00:00,Card payment,Pret,,Eating out,-5.50,GBP,-5.50,GBP,,,,PRET A MANGER,\ntx_2,04/11/2026,09:00:00,Faster payment,Anna,,Income,120.00,GBP,120.00,GBP,Rent share,,,ANNA,',
  paypal: 'Date,Time,TimeZone,Name,Type,Status,Currency,Gross,Fee,Net,From Email Address,To Email Address,Transaction ID\n03/11/2026,10:00:00,CET,Bol.com,Payment,Completed,EUR,-25.00,0.00,-25.00,me@example.invalid,shop@example.invalid,TX-1\n05/11/2026,11:00:00,CET,J Peeters,Payment,Completed,EUR,40.00,-1.00,39.00,j@example.invalid,me@example.invalid,TX-2',
  boursorama: 'dateOp;dateVal;label;category;categoryParent;supplierFound;amount;comment;accountNum;accountLabel;accountbalance\n2026-11-03;2026-11-03;CARTE 03/11 BOULANGER;Loisirs;Loisirs;boulanger;-59,90;;00040xxxxx;COMPTE COURANT;1 240,10\n2026-11-05;2026-11-05;VIR SALAIRE;Revenus;Revenus;acme;1 900,00;;00040xxxxx;COMPTE COURANT;3 140,10'
}

/** A file with a number of lines above the header (bank name, holder, period) and the header below them. */
export const withPreamble = (): string =>
  csv([
    ['Rekening', 'BE33 6511 2345 6746'],
    ['Periode', '01/10/2026 - 31/10/2026'],
    [],
    ['Uittrekselnummer', 'Datum', 'Omschrijving', 'Valuta', 'Bedrag', 'Devies'],
    ['2026-010', '02/10/2026', 'STORTING VAN SPAREN', '02/10/2026', '+500,00', 'EUR'],
    ['2026-010', '15/10/2026', 'BEWAARLOON', '15/10/2026', '-7,50', 'EUR'],
    ['2026-011', '31/10/2026', 'INTREST', '01/11/2026', '+3,12', 'EUR']
  ])

/** Rows with quotes, delimiters inside quoted fields, a doubled quote and a line break inside a field. */
export const quoted = (): string =>
  csv(
    [
      ['Date', 'Payee', 'Memo', 'Amount'],
      ['2026-05-01', 'Smith; Jones & Co', 'He said "hello"', '-10.00'],
      ['2026-05-02', 'Line\nbreak shop', 'two\r\nlines', '-20.50'],
      ['2026-05-03', 'Plain', 'comma, inside', '35.00']
    ],
    ','
  )

export const negatives = (): string =>
  csv([
    ['Datum', 'Omschrijving', 'Bedrag'],
    ['01/06/2026', 'Parentheses', '(12,50)'],
    ['02/06/2026', 'Trailing minus', '12,50-'],
    ['03/06/2026', 'Leading minus', '-12,50'],
    ['04/06/2026', 'Plus sign', '+12,50'],
    ['05/06/2026', 'Euro sign', '€ 1.234,56'],
    ['06/06/2026', 'Code after', '77,00 EUR'],
    ['07/06/2026', 'Thousands spaces', '1 234,50']
  ])

export const ukDrCr = (): string =>
  csv(
    [
      ['Date', 'Narrative', 'Amount', 'Balance'],
      ['03/06/2026', 'SUPERMARKET', '45.10 DR', '954.90'],
      ['04/06/2026', 'SALARY', '1,200.00 CR', '2,154.90'],
      ['05/06/2026', 'REFUND', '(9.99)', '2,144.91']
    ],
    ','
  )

export const directionColumn = (): string =>
  csv([
    ['Boekdatum', 'Naam tegenpartij', 'S/H', 'Bedrag'],
    ['01/07/2026', 'Huur', 'S', '700,00'],
    ['02/07/2026', 'Loon', 'H', '2.100,00'],
    ['03/07/2026', 'Supermarkt', 'S', '55,00']
  ])

export const debitCredit = (): string =>
  csv([
    ['Buchungstag', 'Beguenstigter', 'Betrag', 'Soll', 'Haben'],
    ['01.07.2026', 'Vermieter', '', '700,00', ''],
    ['02.07.2026', 'Arbeitgeber', '', '', '2.100,00'],
    ['03.07.2026', 'Markt', '-55,00', '', '']
  ])

/** Bad rows: an impossible date, a bad amount, a zero amount, a refused status, an empty line and a short row. */
export const badRows = (): string =>
  csv(
    [
      ['Date', 'Payee', 'Amount', 'Status'],
      ['2026-10-01', 'Fine row', '-5.00', 'booked'],
      ['2026-02-31', 'Impossible date', '-6.00', 'booked'],
      ['not a date', 'No date', '-7.00', 'booked'],
      ['2026-10-04', 'Bad amount', 'abc', 'booked'],
      ['2026-10-05', 'Zero amount', '0.00', 'booked'],
      ['2026-10-06', 'Refused payment', '-8.00', 'Geweigerd'],
      ['2026-10-07', 'Cancelled payment', '-9.00', 'cancelled'],
      ['2026-10-08', 'Short row'],
      ['2026-10-09', 'Last row', '-10.00', 'booked']
    ],
    ','
  )

export const namedMonths = (): string =>
  csv(
    [
      ['Date', 'Description', 'Amount'],
      ['16 Nov 2026', 'English short', '-1.00'],
      ['3 mars 2026', 'French', '-2.00'],
      ['Nov 17, 2026', 'US long', '-3.00'],
      ['16. März 2026', 'German', '-4.00'],
      ['5-okt-26', 'Dutch two-digit year', '-5.00'],
      ['12 juni 2026', 'Dutch', '-6.00'],
      ['7 diciembre 2026', 'Spanish', '-7.00'],
      ['8 constructor mar 2026', 'Prototype name', '-8.00']
    ],
    ','
  )

export const multiCurrency = (): string =>
  csv(
    [
      ['Date', 'Description', 'Amount', 'Currency'],
      ['2026-08-01', 'Dinner Paris', '-48.00', 'EUR'],
      ['2026-08-02', 'Taxi New York', '-31.50', 'USD'],
      ['2026-08-03', 'Hotel London', '-120.00', 'GBP'],
      ['2026-08-04', 'No currency', '-1.00', ''],
      ['2026-08-05', 'Odd code', '-2.00', 'euro']
    ],
    ','
  )

export const references = (): string =>
  csv(
    [
      ['Date', 'Description', 'Amount', 'Reference'],
      ['2026-09-01', 'Unique one', '-10.00', 'REF-A'],
      ['2026-09-02', 'Repeated ref one', '-20.00', 'STMT-9'],
      ['2026-09-03', 'Repeated ref two', '-30.00', 'STMT-9'],
      ['2026-09-04', 'Pending', '-40.00', '2026-'],
      ['2026-09-05', 'Zeros', '-50.00', '0000'],
      ['2026-09-06', 'Real number', '-60.00', '2026-0001']
    ],
    ','
  )

export const identicalCoffees = (n: number): string =>
  csv(
    [['Date', 'Description', 'Amount'], ...Array.from({ length: n }, () => ['2026-04-01', 'Coffee corner', '-2.50']), ['2026-04-02', 'Other', '-1.00']],
    ','
  )

export const ogm = (): string =>
  csv(
    [
      ['Datum', 'Naam tegenpartij', 'Mededeling', 'Bedrag', 'Rekening tegenpartij'],
      ['01/05/2026', 'Energie NV', '+++090/9337/55493+++', '-80,00', 'BE45 0017 0000 0089'],
      ['02/05/2026', 'Water NV', '090933755493', '-30,00', 'BE45 0017 0000 0089'],
      ['03/05/2026', 'Fout NV', '+++090/9337/55494+++', '-31,00', 'be45001700000089'],
      ['04/05/2026', 'Anna', 'Netflix share', '-5,00', 'BE62 5100 0754 7061']
    ]
  )

export const lowercaseIbans = (): string =>
  csv(
    [
      ['Date', 'Counterparty', 'Amount'],
      ['2026-05-01', 'BE62 5100 0754 7061', '-5.00'],
      ['2026-05-02', 'nl91 abna 0417 1643 00', '-6.00'],
      ['2026-05-03', 'DE89370400440532013000', '7.00']
    ],
    ','
  )

export const withBalance = (newestFirst: boolean): string => {
  const rows = [
    ['2026-02-27', 'Opening move', '-10.00', '990.00'],
    ['2026-02-28', 'Rent', '-500.00', '490.00'],
    ['2026-02-28', 'Groceries', '-40.00', '450.00'],
    ['2026-02-28', 'Interest', '1.50', '451.50']
  ]
  return csv([['Date', 'Description', 'Amount', 'Balance'], ...(newestFirst ? [...rows].reverse() : rows)], ',')
}

/** A statement with a balance that does not follow from the rows. */
export const brokenBalance = (): string =>
  csv(
    [
      ['Date', 'Description', 'Amount', 'Saldo'],
      ['2026-01-02', 'One', '-10.00', '90.00'],
      ['2026-01-03', 'Two', '-10.00', '70.00'],
      ['2026-01-04', 'Three', '-10.00', '60.00']
    ],
    ','
  )

/** Two accounts of one person: money out of one and the same amount into the other, naming each other's number. */
export const transferOut = (): string =>
  csv(
    [
      ['Date', 'Description', 'Counterparty IBAN', 'Amount'],
      ['2026-06-10', 'To savings', 'BE71096123456769', '-300.00'],
      ['2026-06-11', 'To a friend', 'BE62510007547061', '-20.00']
    ],
    ','
  )
export const transferIn = (): string =>
  csv(
    [
      ['Date', 'Description', 'Counterparty IBAN', 'Amount'],
      ['2026-06-10', 'From checking', 'BE68539007547034', '300.00'],
      ['2026-06-12', 'Unnamed deposit', '', '20.00']
    ],
    ','
  )

export const sevenDescriptions = (): string =>
  csv(
    [
      ['Datum', 'Omschrijving', 'Omschrijving 1', 'Omschrijving 2', 'Omschrijving 3', 'Beschrijving', 'Details', 'Memo', 'Bedrag'],
      ['01/01/2026', 'a', 'b', 'c', 'd', 'e', 'f', 'g', '-1,00']
    ]
  )

export const duplicateColumnsReordered = (): string =>
  csv(
    [
      ['Amount', 'Description', 'Date'],
      ['-12.50', 'Coffee beans', '2026-03-01'],
      ['2500.00', 'Salary March', '2026-03-02'],
      ['-23.40', 'Train ticket', '2026-03-04']
    ],
    ','
  )

export const shiftedDates = (): string =>
  csv(
    [
      ['Date', 'Description', 'Amount'],
      ['2026-03-03', 'Coffee beans store', '-12.50'],
      ['2026-03-06', 'Salary March ACME', '2500.00'],
      ['2026-03-20', 'Train ticket far', '-23.40']
    ],
    ','
  )

export const emptyAndShort = (): string => 'Date,Amount\n\n\n,\n2026-01-01,-5.00\n2026-01-02\n,,,,\n2026-01-03,-6.00,extra,cells\n'

export const lineEndings = (eol: string): string => ['Date,Description,Amount', '2026-01-01,One,-1.00', '2026-01-02,Two,-2.00', '2026-01-03,Three,-3.00'].join(eol) + eol

/** A seeded file of n rows over a year, with repeated merchants, some duplicates of earlier rows and a balance column. */
export function bigFile(n: number, seed: number): string {
  const rand = rng(seed)
  const merchants = ['Albert Heijn', 'Delhaize Gent', 'Colruyt', 'Shell', 'Spotify', 'Netflix', 'Bakkerij Zon', 'Apotheek Noord', 'IKEA', 'Decathlon', 'Taxi Gent', 'Cinema Royal']
  const rows: string[][] = [['Date', 'Counterparty', 'Description', 'Amount', 'Reference']]
  for (let i = 0; i < n; i++) {
    const month = 1 + Math.floor(rand() * 12)
    const day = 1 + Math.floor(rand() * 28)
    const merchant = merchants[Math.floor(rand() * merchants.length)]!
    const cents = Math.floor(rand() * 20000) + 1
    const income = rand() < 0.08
    const amount = ((income ? cents * 5 : -cents) / 100).toFixed(2)
    rows.push([`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, merchant, `Payment ${merchant} #${Math.floor(rand() * 1000)}`, amount, i % 4 === 0 ? `R${i}` : ''])
  }
  return csv(rows, ',')
}

// ------------------------------------------------------------------------------------------------------ CAMT XML

export interface Ntry {
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
export const ntry = (e: Ntry): string =>
  `<Ntry><Amt Ccy="${e.ccy ?? 'EUR'}">${e.amt}</Amt><CdtDbtInd>${e.dir ?? 'DBIT'}</CdtDbtInd>${e.rvsl ? '<RvslInd>true</RvslInd>' : ''}<Sts>${e.booked ?? 'BOOK'}</Sts>` +
  `<BookgDt><Dt>${e.date ?? '2026-03-04'}</Dt></BookgDt><ValDt><Dt>${e.value ?? e.date ?? '2026-03-04'}</Dt></ValDt>${e.info ? `<AddtlNtryInf>${e.info}</AddtlNtryInf>` : ''}${e.inner ?? ''}</Ntry>`
export const bal = (code: string, amt: string, dir: 'CRDT' | 'DBIT', date: string): string =>
  `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>${dir}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`
export const stmt = (entries: string[], o: { iban?: string; bals?: string[]; tag?: string; ccy?: string } = {}): string =>
  `<${o.tag ?? 'Stmt'}><Id>S1</Id><Acct><Id><IBAN>${o.iban ?? OWN}</IBAN></Id><Ccy>${o.ccy ?? 'EUR'}</Ccy></Acct>${(o.bals ?? []).join('')}${entries.join('')}</${o.tag ?? 'Stmt'}>`
export const doc = (body: string, ns = NS, wrap = 'BkToCstmrStmt'): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${ns}"><${wrap}><GrpHdr><MsgId>M1</MsgId></GrpHdr>${body}</${wrap}></Document>`
export const tx = (parts: string): string => `<NtryDtls><TxDtls>${parts}</TxDtls></NtryDtls>`
export const payTo = (name: string, iban: string, text: string, refs = ''): string =>
  `<Refs>${refs}</Refs><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${iban}</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf>`

/** The statement of tests/camt.test.ts (three entries, one in USD, balances that are 9.99 apart). */
export const marchStatement = (extra: string[] = []): string =>
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

/** n entries, each a payment to a merchant of a seeded list. */
export function bigXml(n: number, seed: number): string {
  const rand = rng(seed)
  const entries = Array.from({ length: n }, (_, i) => {
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0')
    const cents = 100 + Math.floor(rand() * 90000)
    return ntry({
      amt: (cents / 100).toFixed(2),
      dir: rand() < 0.1 ? 'CRDT' : 'DBIT',
      date: `2026-03-${day}`,
      inner: tx(payTo(`Merchant ${Math.floor(rand() * 40)}`, OTHER, `Payment ${i}`, `<AcctSvcrRef>R${i}</AcctSvcrRef>`))
    })
  })
  return doc(stmt(entries, { bals: [bal('OPBD', '1000.00', 'CRDT', '2026-03-01')] }))
}
