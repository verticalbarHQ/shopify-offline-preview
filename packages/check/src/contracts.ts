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
const featureFields = {
  kind: z.enum(["filter", "tag", "object", "object-property"]),
  name: z.string(),
  known: z.boolean(),
  oracleCases: z.array(z.string()),
  verified: z.boolean(),
  occurrences: z.array(z.strictObject({ file: z.string(), line: z.number().int().positive() })),
};
/** A feature is either provided by the preview or not; only one it does not provide can be server-only. */
export const featureSchema = z.union([
  z.strictObject({
    ...featureFields,
    registered: z.literal(true),
    implemented: z.literal(true),
    serverOnly: z.literal(false),
  }),
  z.strictObject({
    ...featureFields,
    registered: z.literal(false),
    implemented: z.literal(false),
    serverOnly: z.boolean(),
  }),
]);
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
