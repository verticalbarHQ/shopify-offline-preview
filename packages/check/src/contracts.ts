import { z } from "zod";

export const diagnosticSchema = z.strictObject({
  code: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  nodeId: z.string().nullable(),
  message: z.string(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export const featureSchema = z.strictObject({
  kind: z.enum(["filter", "tag", "object", "object-property"]),
  name: z.string(),
  known: z.boolean(),
  registered: z.boolean(),
  serverOnly: z.boolean(),
  oracleCases: z.array(z.string()),
  implemented: z.boolean(),
  verified: z.boolean(),
  occurrences: z.array(z.strictObject({ file: z.string(), line: z.number().int().positive() })),
});
export type Feature = z.infer<typeof featureSchema>;
export const checkSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  supported: z.boolean(),
  specCommit: z.string(),
  pages: z.array(
    z.strictObject({
      pageType: z.string(),
      template: z.string(),
      files: z.array(z.string()),
      features: z.array(featureSchema),
      unimplementedCount: z.number().int().nonnegative(),
      complete: z.boolean(),
    }),
  ),
  diagnostics: z.array(diagnosticSchema),
  summary: z.strictObject({
    featureCount: z.number().int().nonnegative(),
    unimplementedCount: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
});
export type CheckResult = z.infer<typeof checkSchema>;
