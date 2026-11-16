import { z } from 'zod';

/**
 * Response schemas, limited to the fields CulGate reads. Lenient on purpose:
 * unknown fields are ignored and non-essential fields are optional. The full
 * response is preserved separately as `raw`.
 */

export const errorResponseSchema = z.object({
  error_code: z.string(),
  message: z.string().nullish(),
});

export const paymentRequestSchema = z.object({
  payment_request_id: z.string(),
  reference_id: z.string().nullish(),
  latest_payment_id: z.string().nullish(),
  currency: z.string(),
  request_amount: z.number(),
  channel_code: z.string().nullish(),
  status: z.string(),
  actions: z
    .array(
      z.object({
        type: z.string().nullish(),
        descriptor: z.string().nullish(),
        value: z.string().nullish(),
      }),
    )
    .nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  created: z.string().nullish(),
  updated: z.string().nullish(),
});

export const paymentSchema = z.object({
  payment_id: z.string(),
  payment_request_id: z.string().nullish(),
});

export const refundSchema = z.object({
  refund_id: z.string(),
  payment_id: z.string(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  reason: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  created: z.string().nullish(),
});

export type XenditPaymentRequest = z.infer<typeof paymentRequestSchema>;
export type XenditRefund = z.infer<typeof refundSchema>;
