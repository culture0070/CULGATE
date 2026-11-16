import { z } from 'zod';

/**
 * Response schemas, limited to the fields CulGate reads. They are lenient on
 * purpose: unknown fields are ignored and undocumented fields are optional,
 * so an additive provider change does not break parsing. The full response is
 * preserved separately as `raw`.
 */

const timestamp = z.number().nullish();

export const errorResponseSchema = z.object({
  errors: z
    .array(
      z.object({
        code: z.string(),
        detail: z.string().nullish(),
        sub_code: z.string().nullish(),
        source: z.object({ pointer: z.string().nullish() }).nullish(),
      }),
    )
    .min(1),
});

const paymentSummarySchema = z.object({
  id: z.string(),
  attributes: z
    .object({
      amount: z.number().int().nullish(),
      currency: z.string().nullish(),
      status: z.string().nullish(),
      payment_intent_id: z.string().nullish(),
      refunds: z
        .array(
          z.object({
            id: z.string(),
            attributes: z
              .object({ status: z.string().nullish(), amount: z.number().int().nullish() })
              .default({}),
          }),
        )
        .nullish(),
    })
    .default({}),
});

export const paymentResponseSchema = z.object({ data: paymentSummarySchema });

export const paymentIntentResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({
      amount: z.number().int(),
      currency: z.string(),
      status: z.string(),
      description: z.string().nullish(),
      payment_method_allowed: z.array(z.string()).nullish(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
      next_action: z
        .object({
          type: z.string().nullish(),
          redirect: z.object({ url: z.string().nullish() }).nullish(),
        })
        .nullish(),
      payments: z.array(paymentSummarySchema).nullish(),
      created_at: timestamp,
      updated_at: timestamp,
    }),
  }),
});

export const paymentMethodResponseSchema = z.object({
  data: z.object({ id: z.string() }),
});

export const refundResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({
      amount: z.number().int(),
      currency: z.string(),
      status: z.string(),
      payment_id: z.string(),
      reason: z.string().nullish(),
      notes: z.string().nullish(),
      created_at: timestamp,
      updated_at: timestamp,
    }),
  }),
});

export type PayMongoPaymentIntent = z.infer<typeof paymentIntentResponseSchema>['data'];
export type PayMongoRefund = z.infer<typeof refundResponseSchema>['data'];
