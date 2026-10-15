import { z } from "zod";

// Admin API content resources expose SEO through these global metafields, unlike Product/Collection.
// https://shopify.dev/docs/apps/build/marketing/optimize-storefront-seo
const keys = { title: "title_tag", description: "description_tag" } as const;
const field = z.object({ value: z.string(), type: z.literal("single_line_text_field") }).nullable();
export const contentSeoFields = { seoTitle: field, seoDescription: field };
export const contentSeoSelection = `seoTitle: metafield(namespace:"global", key:"${keys.title}") { value type } seoDescription: metafield(namespace:"global", key:"${keys.description}") { value type }`;
export function normalizeContentSeo<T extends z.infer<z.ZodObject<typeof contentSeoFields>>>(
  input: T,
) {
  const { seoTitle, seoDescription, ...rest } = input;
  return {
    ...rest,
    seo: { title: seoTitle?.value ?? null, description: seoDescription?.value ?? null },
  };
}
/** Null requires absence on mandatory readback; this helper never deletes an existing metafield. */
export function contentSeoMetafields(
  source:
    | { title?: string | null | undefined; description?: string | null | undefined }
    | undefined,
) {
  return (["title", "description"] as const).flatMap((name) => {
    const value = source?.[name];
    return value === null || value === undefined
      ? []
      : [{ namespace: "global", key: keys[name], type: "single_line_text_field", value }];
  });
}
