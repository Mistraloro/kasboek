/** ISO 4217 currency codes the runtime knows (about 160), for pickers and validation. */
export const CURRENCIES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('currency')
  } catch {
    return ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'BRL', 'MXN', 'INR', 'CNY']
  }
})()

/** Currencies the ECB publishes reference rates for (against the euro). */
export const ECB_CURRENCIES = ['USD', 'JPY', 'BGN', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK', 'TRY', 'AUD', 'BRL', 'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'SGD', 'THB', 'ZAR']
