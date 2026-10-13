import { z } from "zod";
import { parseThemeJson } from "../../theme/src/index.js";

export const settingSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    default: z.unknown().optional(),
  })
  .passthrough();
export const sectionSchema = z
  .object({
    tag: z.string().optional(),
    class: z.string().optional(),
    settings: z.array(settingSchema).default([]),
    blocks: z
      .array(
        z.object({ type: z.string(), settings: z.array(settingSchema).default([]) }).passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type SectionSchema = z.infer<typeof sectionSchema>;
export const blockConfigSchema = z
  .object({
    type: z.string(),
    settings: z.record(z.string(), z.unknown()).default({}),
    disabled: z.boolean().optional(),
  })
  .passthrough();
export const sectionConfigSchema = blockConfigSchema.extend({
  blocks: z.record(z.string(), blockConfigSchema).default({}),
  block_order: z.array(z.string()).optional(),
});
export type SectionConfig = z.infer<typeof sectionConfigSchema>;
export const templateConfigSchema = z
  .object({
    layout: z.union([z.string(), z.literal(false)]).optional(),
    type: z.string().optional(),
    sections: z.record(z.string(), sectionConfigSchema),
    order: z.array(z.string()),
  })
  .passthrough();
export function templateConfig(text: string, file: string) {
  const config = templateConfigSchema.parse(parseThemeJson(text, file));
  if (
    new Set(config.order).size !== config.order.length ||
    config.order.some((id) => !Object.hasOwn(config.sections, id))
  )
    throw new Error("Section order must contain unique existing section IDs");
  return config;
}
export const settingsDataSchema = z
  .object({
    current: z.union([z.string(), z.record(z.string(), z.unknown())]),
    presets: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
