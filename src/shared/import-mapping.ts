import { z } from 'zod'

/** Which CSV column means what. Shared so the UI, the contract and the assistant validate it the same way. */
export const mappingSchema = z
  .object({
    delimiter: z.enum([';', ',', '\t', '|']),
    headerRow: z.number().int().min(0),
    dateOrder: z.enum(['DMY', 'YMD', 'MDY']),
    decimal: z.enum([',', '.']),
    invertSign: z.boolean().default(false),
    columns: z
      .object({
        bookingDate: z.number().int().min(0),
        valueDate: z.number().int().min(0).optional(),
        amount: z.number().int().min(0).optional(),
        debit: z.number().int().min(0).optional(),
        credit: z.number().int().min(0).optional(),
        currency: z.number().int().min(0).optional(),
        counterpartyName: z.number().int().min(0).optional(),
        counterpartyIban: z.number().int().min(0).optional(),
        description: z.array(z.number().int().min(0)).max(6).default([]),
        communication: z.number().int().min(0).optional(),
        bankReference: z.number().int().min(0).optional(),
        status: z.number().int().min(0).optional(),
        balance: z.number().int().min(0).optional()
      })
      .strict()
      .refine((c) => c.amount !== undefined || c.debit !== undefined || c.credit !== undefined, 'An amount column is needed.')
  })
  .strict()

