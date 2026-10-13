import { z } from "zod";
import { diagnosticSchema } from "../../check/src/contracts.js";

export interface RenderNode {
  kind: "layout" | "section-group" | "section" | "block" | "snippet";
  id: string;
  type: string;
  file: string;
  settingsPath: string | null;
  children: RenderNode[];
}
export const renderNodeSchema: z.ZodType<RenderNode> = z.lazy(() =>
  z.strictObject({
    kind: z.enum(["layout", "section-group", "section", "block", "snippet"]),
    id: z.string(),
    type: z.string(),
    file: z.string(),
    settingsPath: z.string().nullable(),
    children: z.array(renderNodeSchema),
  }),
);
// Shared CLI/browser contract; Shopify parity requires separate oracle evidence.
export const renderSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  html: z.string(),
  tree: z.array(renderNodeSchema),
  diagnostics: z.array(diagnosticSchema),
  dataUsed: z.record(z.string(), z.array(z.string())),
  route: z.strictObject({ path: z.string(), pageType: z.string(), template: z.string() }),
});
export type RenderResult = z.infer<typeof renderSchema>;
