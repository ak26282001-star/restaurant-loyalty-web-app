import { z } from "zod";

/** Clover returns nested collections as {"elements": [...]} when expanded. */
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (Array.isArray(v) ? { elements: v } : v), z.object({ elements: z.array(item).default([]) }).partial())
    .optional()
    .transform((v) => v?.elements ?? []);

export const TokenResponse = z.object({
  access_token: z.string().min(1),
  access_token_expiration: z.number().optional(), // Unix seconds
  refresh_token: z.string().optional(),
  refresh_token_expiration: z.number().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const CloverLineItem = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  price: z.number().int().optional(), // cents, per unit
  item: z.looseObject({ id: z.string() }).optional(),
  refunded: z.boolean().optional(),
  exchanged: z.boolean().optional(),
});

export const CloverCustomerRef = z.looseObject({ id: z.string() });

export const CloverOrder = z.looseObject({
  id: z.string(),
  total: z.number().int().optional(), // cents
  currency: z.string().optional(),
  paymentState: z.string().optional(), // OPEN | PAID | REFUNDED | CREDITED | PARTIALLY_PAID | PARTIALLY_REFUNDED
  createdTime: z.number().optional(), // Unix ms
  clientCreatedTime: z.number().optional(),
  lineItems: list(CloverLineItem),
  customers: list(CloverCustomerRef),
});
export type CloverOrder = z.infer<typeof CloverOrder>;

export const CloverCustomer = z.looseObject({
  id: z.string(),
  firstName: z.string().optional(),
  phoneNumbers: list(z.looseObject({ phoneNumber: z.string().optional() })),
  emailAddresses: list(z.looseObject({ emailAddress: z.string().optional() })),
});
export type CloverCustomer = z.infer<typeof CloverCustomer>;

export const CloverItem = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  price: z.number().int().optional(),
  hidden: z.boolean().optional(),
});
export const CloverItemPage = z.object({ elements: z.array(CloverItem).default([]) });

export const WebhookPayload = z.union([
  z.object({ verificationCode: z.string().min(1).max(200) }),
  z.object({
    appId: z.string(),
    merchants: z.record(
      z.string(),
      z.array(z.object({ objectId: z.string(), type: z.enum(["CREATE", "UPDATE", "DELETE"]), ts: z.number() })),
    ),
  }),
]);
