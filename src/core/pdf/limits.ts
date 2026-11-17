/**
 * What a PDF may hold before it is refused. Kept apart from the reader so the app can know them without loading pdf.js.
 * A real statement stays under about 30,000 pieces of text and 400,000 characters; these leave room for a long one.
 */
export const PDF_LIMITS = { maxPages: 150, maxItems: 100_000, maxChars: 1_000_000 }
