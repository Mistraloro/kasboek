import { describe, expect, it } from 'vitest'
import { parseAmount } from '@shared/amount'
import { autoMap } from '@core/csv/mapping'
import { normalizeRows, parseDate } from '@core/csv/normalize'
import { detectDelimiter, parseCsv } from '@core/csv/read'

/** Two rows per bank, as their exports write them: one payment out, one in. Names and amounts are made up. */
const BANKS: { bank: string; csv: string; out: [string, number, string | null]; in: [string, number, string | null] }[] = [
  {
    bank: 'ING (Netherlands)',
    csv: 'Datum;Naam / Omschrijving;Rekening;Tegenrekening;Code;Af Bij;Bedrag (EUR);Mutatiesoort;Mededelingen;Saldo na mutatie;Tag\n20261103;Albert Heijn 1234;NL20INGB0001234567;;BA;Af;23,45;Betaalautomaat;Pasvolgnr: 001;1.000,00;\n20261105;Werkgever BV;NL20INGB0001234567;NL91ABNA0417164300;OV;Bij;2.500,00;Overschrijving;Salaris november;3.500,00;',
    out: ['2026-11-03', -2345, 'Albert Heijn 1234'],
    in: ['2026-11-05', 250000, 'Werkgever BV']
  },
  {
    bank: 'Rabobank',
    csv: '"IBAN/BBAN","Munt","BIC","Volgnr","Datum","Rentedatum","Bedrag","Saldo na trn","Tegenrekening IBAN/BBAN","Naam tegenpartij","Naam uiteindelijke partij","Naam initiërende partij","BIC tegenpartij","Code","Batch ID","Transactiereferentie","Machtigingskenmerk","Incassant ID","Betalingskenmerk","Omschrijving-1","Omschrijving-2","Omschrijving-3"\n"NL11RABO0123456789","EUR","RABONL2U","000000000000001234","2026-11-03","2026-11-03","-12,50","987,50","NL91ABNA0417164300","Jumbo","","","","bc","","","","","","Jumbo Utrecht","",""\n"NL11RABO0123456789","EUR","RABONL2U","000000000000001235","2026-11-04","2026-11-04","+100,00","1087,50","NL91ABNA0417164300","J. Jansen","","","","tb","","","","","","Terugbetaling","",""',
    out: ['2026-11-03', -1250, 'Jumbo'],
    in: ['2026-11-04', 10000, 'J. Jansen']
  },
  {
    bank: 'KBC (Belgium)',
    csv: 'Rekeningnummer;Rubrieknaam;Naam;Munt;Afschriftnummer;Datum;Omschrijving;Valuta;Bedrag;Saldo;credit;debet;rekeningnummer tegenpartij;BIC tegenpartij;Naam tegenpartij;Adres tegenpartij;gestructureerde mededeling;Vrije mededeling\nBE68539007547034;Zichtrekening;JAN PEETERS;EUR;2026011;03/11/2026;BETALING DELHAIZE;03/11/2026;-45,10;954,90;;45,10;;;DELHAIZE;;;\nBE68539007547034;Zichtrekening;JAN PEETERS;EUR;2026011;05/11/2026;OVERSCHRIJVING;05/11/2026;1.200,00;2.154,90;1.200,00;;BE71096123456769;GKCCBEBB;WERKGEVER NV;;;Loon',
    out: ['2026-11-03', -4510, 'DELHAIZE'],
    in: ['2026-11-05', 120000, 'WERKGEVER NV']
  },
  {
    bank: 'Belfius',
    csv: 'Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen\nBE68539007547034;03/11/2026;11;1001;;COLRUYT;;;Betaling met kaart;03/11/2026;-30,00;EUR;;BE;\nBE68539007547034;06/11/2026;11;1002;BE71096123456769;PEETERS;;;Overschrijving;06/11/2026;50,00;EUR;GKCCBEBB;BE;Etentje',
    out: ['2026-11-03', -3000, 'COLRUYT'],
    in: ['2026-11-06', 5000, 'PEETERS']
  },
  {
    bank: 'Deutsche Bank',
    csv: 'Buchungstag;Wert;Umsatzart;Begünstigter / Auftraggeber;Verwendungszweck;IBAN;BIC;Kundenreferenz;Mandatsreferenz ;Gläubiger ID;Fremde Gebühren;Betrag;Abweichender Empfänger;Anzahl der Aufträge;Anzahl der Schecks;Soll;Haben;Währung\n03.11.2026;03.11.2026;Kartenzahlung;REWE Markt;REWE SAGT DANKE;;;;;;;;;;;-27,80;;EUR\n05.11.2026;05.11.2026;Gutschrift;Arbeitgeber GmbH;Gehalt November;DE89370400440532013000;COBADEFFXXX;;;;;;;;;;3.100,00;EUR',
    out: ['2026-11-03', -2780, 'REWE Markt'],
    in: ['2026-11-05', 310000, 'Arbeitgeber GmbH']
  },
  {
    bank: 'Sparkasse',
    csv: '"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Glaeubiger ID";"Mandatsreferenz";"Kundenreferenz (End-to-End)";"Sammlerreferenz";"Lastschrift Ursprungsbetrag";"Auslagenersatz Ruecklastschrift";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"BIC (SWIFT-Code)";"Betrag";"Waehrung";"Info"\n"DE12500105170648489890";"03.11.26";"03.11.26";"KARTENZAHLUNG";"EDEKA";"";"";"";"";"";"";"EDEKA Center";"DE44500105175407324931";"INGDDEFFXXX";"-15,99";"EUR";"Umsatz gebucht"\n"DE12500105170648489890";"05.11.26";"05.11.26";"GUTSCHR. UEBERWEISUNG";"Miete";"";"";"";"";"";"";"Max Mustermann";"DE89370400440532013000";"COBADEFFXXX";"650,00";"EUR";"Umsatz gebucht"',
    out: ['2026-11-03', -1599, 'EDEKA Center'],
    in: ['2026-11-05', 65000, 'Max Mustermann']
  },
  {
    bank: 'N26',
    csv: '"Booking Date","Value Date","Partner Name","Partner Iban","Type","Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"\n"2026-11-03","2026-11-03","Lidl","","Presentment","","Main Account","-8.49","","",""\n"2026-11-05","2026-11-05","Anna Schmidt","DE89370400440532013000","Credit Transfer","Rent share","Main Account","400.00","","",""',
    out: ['2026-11-03', -849, 'Lidl'],
    in: ['2026-11-05', 40000, 'Anna Schmidt']
  },
  {
    bank: 'Revolut',
    csv: 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCARD_PAYMENT,Current,2026-11-03 10:15:02,2026-11-04 09:01:33,Spotify,-10.99,0.00,EUR,COMPLETED,489.01\nTOPUP,Current,2026-11-05 12:00:00,2026-11-05 12:00:01,Top-Up by *1234,200.00,0.00,EUR,COMPLETED,689.01',
    out: ['2026-11-04', -1099, null],
    in: ['2026-11-05', 20000, null]
  },
  {
    bank: 'Wise',
    csv: '"TransferWise ID",Date,Amount,Currency,Description,"Payment Reference","Running Balance","Exchange From","Exchange To","Exchange Rate","Payer Name","Payee Name","Payee Account Number",Merchant,"Card Last Four Digits","Card Holder Full Name",Attachment,Note,"Total fees"\nCARD-123,03-11-2026,-25.00,EUR,"Card transaction of 25.00 EUR issued by Bol.com",,475.00,,,,,,,Bol.com,1234,"J PEETERS",,,0.00\nTRANSFER-456,05-11-2026,300.00,EUR,"Received money from J Peeters",,775.00,,,,"J Peeters",,,,,,,,0.00',
    out: ['2026-11-03', -2500, 'Bol.com'],
    in: ['2026-11-05', 30000, null]
  },
  {
    bank: 'PayPal',
    csv: '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID"\n"03/11/2026","10:00:00","CET","Etsy","Express Checkout Payment","Completed","EUR","-19,99","0,00","-19,99","me@example.com","shop@example.com","1AB23456CD789012E"\n"05/11/2026","11:00:00","CET","Marie","General Payment","Completed","EUR","15,00","0,00","15,00","marie@example.com","me@example.com","9ZY87654XW321098V"',
    out: ['2026-11-03', -1999, 'Etsy'],
    in: ['2026-11-05', 1500, 'Marie']
  },
  {
    bank: 'Lloyds (UK)',
    csv: 'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance\n03/11/2026,DEB,\'30-94-57,12345678,TESCO STORES 1234,32.10,,1234.56\n05/11/2026,FPI,\'30-94-57,12345678,EMPLOYER LTD,,2000.00,3234.56',
    out: ['2026-11-03', -3210, null],
    in: ['2026-11-05', 200000, null]
  },
  {
    bank: 'Chase (US)',
    csv: 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,11/03/2026,"WHOLEFDS MKT 10234",-54.21,DEBIT_CARD,1945.79,,\nCREDIT,11/13/2026,"ACME CORP PAYROLL",2500.00,ACH_CREDIT,4445.79,,',
    out: ['2026-11-03', -5421, null],
    in: ['2026-11-13', 250000, null]
  },
  {
    bank: 'Santander (Spain)',
    csv: 'Fecha Operación;Fecha Valor;Concepto;Importe;Saldo\n03/11/2026;03/11/2026;Compra Mercadona;-41,30;958,70\n05/11/2026;05/11/2026;Nómina Empresa SL;1.800,00;2.758,70',
    out: ['2026-11-03', -4130, null],
    in: ['2026-11-05', 180000, null]
  },
  {
    bank: 'CGD (Portugal)',
    csv: 'Data mov.;Data valor;Descrição;Débito;Crédito;Saldo contabilístico\n03-11-2026;03-11-2026;Compra Pingo Doce;12,40;;987,60\n05-11-2026;05-11-2026;Transferência recebida;;500,00;1.487,60',
    out: ['2026-11-03', -1240, null],
    in: ['2026-11-05', 50000, null]
  },
  {
    bank: 'Intesa Sanpaolo (Italy)',
    csv: 'Data;Operazione;Dettagli;Conto o carta;Contabilizzazione;Categoria;Valuta;Importo\n03/11/2026;Pagamento POS;Esselunga;Conto;Contabilizzato;Spesa;EUR;-33,50\n05/11/2026;Bonifico a vostro favore;Stipendio;Conto;Contabilizzato;Stipendio;EUR;1.700,00',
    out: ['2026-11-03', -3350, null],
    in: ['2026-11-05', 170000, null]
  },
  {
    bank: 'Nubank (Brazil)',
    csv: 'Data,Valor,Identificador,Descrição\n03/11/2026,-29.90,abc-123,Compra no débito - Padaria\n05/11/2026,150.00,def-456,Transferência recebida',
    out: ['2026-11-03', -2990, null],
    in: ['2026-11-05', 15000, null]
  },
  {
    bank: 'Monzo (UK)',
    csv: 'Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In\ntx_1,03/11/2026,10:00:00,Card payment,Pret A Manger,,Eating out,-4.50,GBP,-4.50,GBP,,,,PRET A MANGER LONDON,,-4.50,\ntx_2,05/11/2026,09:00:00,Faster payment,Sam,,Transfers,25.00,GBP,25.00,GBP,Dinner,,,SAM,,,25.00',
    out: ['2026-11-03', -450, 'Pret A Manger'],
    in: ['2026-11-05', 2500, 'Sam']
  }
]

describe('CSV exports of many banks', () => {
  for (const b of BANKS) {
    it(b.bank, () => {
      const text = b.csv
      const delimiter = detectDelimiter(text)
      const rows = parseCsv(text, delimiter)
      const mapping = autoMap(rows, delimiter as ';')
      expect(mapping, 'no mapping').not.toBeNull()
      const clean = normalizeRows(rows, mapping!, rows[1]?.find((c) => /^[A-Z]{3}$/.test(c)) ?? 'EUR')
      const pick = (r: (typeof clean)[number]): [string | null, number | null, string | null] => [r.bookingDate, r.amountCents, b.out[2] === null && b.in[2] === null ? null : r.counterpartyName]
      expect(pick(clean[0]!)).toEqual(b.out)
      expect(pick(clean[1]!)).toEqual(b.in)
      expect(clean.every((r) => !r.issues.includes('date_invalid') && !r.issues.includes('amount_invalid'))).toBe(true)
    })
  }
})

describe('dates and amounts as banks write them', () => {
  it('reads month names in several languages', () => {
    expect(parseDate('16 Nov 2026', 'DMY')).toBe('2026-11-16')
    expect(parseDate('Nov 16, 2026', 'MDY')).toBe('2026-11-16')
    expect(parseDate('16-nov-26', 'DMY')).toBe('2026-11-16')
    expect(parseDate('3. März 2026', 'DMY')).toBe('2026-03-03')
    expect(parseDate('3 décembre 2026', 'DMY')).toBe('2026-12-03')
    expect(parseDate('2026-11-16T10:00:00Z', 'YMD')).toBe('2026-11-16')
  })
  it('reads currency codes and DR/CR', () => {
    expect(parseAmount('USD 12.50', '.')).toBe(1250)
    expect(parseAmount('12,50 CHF', ',')).toBe(1250)
    expect(parseAmount('R$ 9,90', ',')).toBe(990)
    expect(parseAmount('12.50 DR', '.')).toBe(-1250)
    expect(parseAmount('12.50 CR', '.')).toBe(1250)
    expect(parseAmount('-€1,234.56', '.')).toBe(-123456)
    expect(parseAmount('£4.50', '.')).toBe(450)
  })
})
