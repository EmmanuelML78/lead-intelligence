import { z } from "zod";
import type { RawAdvisor, RawLead, RawMotorcycle } from "./types";

// Deliberately loose: we only hard-require the fields we cannot operate
// without (the natural keys). Everything else is allowed to be blank and is
// handled downstream by normalization + data-quality issues, per the "do
// not silently fix, but keep processing valid rows" rule.
export const rawLeadRowSchema = z.object({
  lead_id: z.string().trim().min(1),
  empresa_id: z.string().trim().min(1),
  punto_venta_id: z.string().trim().min(1)
});

export const rawAdvisorRowSchema = z.object({
  asesor_id: z.string().trim().min(1),
  empresa_id: z.string().trim().min(1),
  punto_venta_id: z.string().trim().min(1)
});

export const rawMotorcycleRowSchema = z.object({
  sku: z.string().trim().min(1)
});

export type RowValidation<T> =
  | { valid: true; row: T }
  | { valid: false; row: T; errors: string[] };

function validateRow<T>(schema: z.ZodType<unknown>, row: T): RowValidation<T> {
  const result = schema.safeParse(row);
  if (result.success) return { valid: true, row };
  return { valid: false, row, errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
}

export function validateRawLead(row: RawLead): RowValidation<RawLead> {
  return validateRow(rawLeadRowSchema, row);
}

export function validateRawAdvisor(row: RawAdvisor): RowValidation<RawAdvisor> {
  return validateRow(rawAdvisorRowSchema, row);
}

export function validateRawMotorcycle(row: RawMotorcycle): RowValidation<RawMotorcycle> {
  return validateRow(rawMotorcycleRowSchema, row);
}
