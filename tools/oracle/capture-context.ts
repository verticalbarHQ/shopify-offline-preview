import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import { liquidPrice } from "../../packages/data/src/objects.js";
import { validateSnapshotReferences } from "../../packages/data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../../packages/data/src/schema.js";
import { oracleThemeSchema } from "./admin-read.js";
import {
  type CaptureDependencies,
  type CapturedPage,
  type CaptureInput,
  captureOraclePage,
} from "./capture.js";
import { assertOracleStore } from "./store-guard.js";

export const captureContextKey = "sop-capture-context-v1";
export const captureContextSnippet = `snippets/${captureContextKey}.liquid`;
const identifier = (path: string) => `{{${path} | append: '' | json}}`;
/** Fixed authored expressions, never expected IDs, timestamps, flags or line keys. Append only to comparison copies. */
export const captureContextSource = `{% capture sop_capture_context_payload %}{"shopId":${identifier("shop.id")},"domain":{{shop.permanent_domain | json}},"path":{{request.path | json}},"locale":{{request.locale.iso_code | json}},"epoch":{{'now' | date: '%s' | json}},"cart":{"currency":{{cart.currency.iso_code | json}},"note":{{cart.note | json}},"taxesIncluded":{{cart.taxes_included | json}},"dutiesIncluded":{{cart.duties_included | json}},"itemCount":{{cart.item_count | json}},"originalTotal":{{cart.original_total_price | json}},"subtotal":{{cart.items_subtotal_price | json}},"total":{{cart.total_price | json}},"discount":{{cart.total_discount | json}},"items":[{% for sop_context_item in cart.items %}{"variantId":${identifier("sop_context_item.variant_id")},"productId":${identifier("sop_context_item.product.id")},"handle":{{sop_context_item.product.handle | json}},"key":{{sop_context_item.key | json}},"quantity":{{sop_context_item.quantity | json}},"price":{{sop_context_item.price | json}},"originalPrice":{{sop_context_item.original_price | json}},"finalPrice":{{sop_context_item.final_price | json}},"linePrice":{{sop_context_item.line_price | json}},"originalLinePrice":{{sop_context_item.original_line_price | json}},"finalLinePrice":{{sop_context_item.final_line_price | json}},"instructions":{% if sop_context_item.instructions == nil %}null{% else %}{"can_remove":{{sop_context_item.instructions.can_remove | json}},"can_update_quantity":{{sop_context_item.instructions.can_update_quantity | json}}}{% endif %},"parentRelationship":{{sop_context_item.parent_relationship | json}},"itemComponents":{{sop_context_item.item_components | json}}}{% unless forloop.last %},{% endunless %}{% endfor %}]}}{% endcapture %}<script id="${captureContextKey}" type="application/json">{{sop_capture_context_payload | base64_encode | json}}</script>`;
export const captureContextHash = createHash("sha256").update(captureContextSource).digest("hex");
export class CaptureContextError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "invalid-payload"
      | "context-mismatch"
      | "unstable-context"
      | "unverified-context",
  ) {
    super(`Oracle capture context failed: ${code}`);
    this.name = "CaptureContextError";
  }
}
const money = z.number().int().nonnegative().safe(),
  identifierSchema = z.string().regex(/^[1-9]\d*$/),
  contextSchema = z.strictObject({
    shopId: identifierSchema,
    domain: z.string(),
    path: z.string().startsWith("/"),
    locale: z.string().min(1),
    epoch: z.string().regex(/^\d{10}$/),
    cart: z.strictObject({
      currency: z.string().min(1),
      note: z.string().nullable(),
      taxesIncluded: z.boolean().nullable(),
      dutiesIncluded: z.boolean().nullable(),
      itemCount: money,
      originalTotal: money,
      subtotal: money,
      total: money,
      discount: money,
      items: z
        .array(
          z.strictObject({
            variantId: identifierSchema,
            productId: identifierSchema,
            handle: z.string().min(1),
            key: z.string().min(1).max(1024),
            quantity: z.number().int().positive().safe(),
            price: money,
            originalPrice: money,
            finalPrice: money,
            linePrice: money,
            originalLinePrice: money,
            finalLinePrice: money,
            instructions: z
              .strictObject({ can_remove: z.boolean(), can_update_quantity: z.boolean() })
              .nullable(),
            parentRelationship: z.record(z.string(), z.json()).nullable(),
            itemComponents: z.array(z.record(z.string(), z.json())).nullable(),
          }),
        )
        .max(250),
    }),
  });
export type NativeCaptureContext = z.infer<typeof contextSchema>;
export function extractNativeCaptureContext(html: string): NativeCaptureContext {
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new CaptureContextError("invalid-payload");
  try {
    const scripts: string[] = [];
    function visit(node: DefaultTreeAdapterTypes.Node) {
      if (
        "tagName" in node &&
        node.tagName === "script" &&
        node.attrs.some((attr) => attr.name === "id" && attr.value === captureContextKey)
      ) {
        if (!node.attrs.some((attr) => attr.name === "type" && attr.value === "application/json"))
          throw new Error();
        scripts.push(
          node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""),
        );
      }
      if ("childNodes" in node) node.childNodes.forEach(visit);
    }
    visit(parse(html));
    if (scripts.length !== 1) throw new Error();
    const encoded = z.string().parse(JSON.parse(scripts[0] ?? "")),
      bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > 1024 * 1024) throw new Error();
    return contextSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  } catch {
    throw new CaptureContextError("invalid-payload");
  }
}
export interface VerifiedCaptureContext {
  readonly kind: "verified-capture-context";
}
interface Observation {
  domain: string;
  shopId: string;
  path: string;
  requestPath: string;
  previewThemeId: string;
  snippetHash: string;
  rawHashes: readonly string[];
  summaryHash: string;
  sectionTextHash: string;
  contexts: readonly [NativeCaptureContext, NativeCaptureContext];
}
const observations = new WeakMap<VerifiedCaptureContext, Observation>();
export function inspectVerifiedCaptureContext(receipt: VerifiedCaptureContext): Observation {
  const value = observations.get(receipt);
  if (!value) throw new CaptureContextError("unverified-context");
  return structuredClone(value);
}
export interface ContextCaptureDependencies extends CaptureDependencies {
  /** Mandatory: exact comparison-copy files, including captureContextSource/hash and its layout inclusion. */
  verifyThemeFiles: NonNullable<CaptureDependencies["verifyThemeFiles"]>;
  /** Fresh read of the uploaded reserved snippet; compared byte for byte with the authored source. */
  readCaptureContextSource(themeId: string): Promise<string>;
}
/** Captures actual HTML through the guarded transport; context proof is never minted from a caller-supplied page object. */
export async function captureOracleContextPage(
  inputValue: CaptureInput,
  shopId: string,
  dependencyValues: ContextCaptureDependencies,
): Promise<{ capture: CapturedPage; context: VerifiedCaptureContext }> {
  const input = structuredClone(inputValue),
    dependencies = { ...dependencyValues };
  if (
    !/^gid:\/\/shopify\/Shop\/[1-9]\d*$/.test(shopId) ||
    typeof dependencies.verifyThemeFiles !== "function" ||
    typeof dependencies.readCaptureContextSource !== "function"
  )
    throw new CaptureContextError("invalid-input");
  const start = Date.now(),
    expectedPath = new URL(input.path, `https://${input.config.domain}`).pathname;
  const check = async () => {
    const identity = await dependencies.readIdentity(),
      theme = oracleThemeSchema.parse(await dependencies.readTheme(input.previewThemeId));
    assertOracleStore(input.config, identity);
    if (
      identity.id !== shopId ||
      theme.id !== `gid://shopify/OnlineStoreTheme/${input.previewThemeId}` ||
      theme.role !== "UNPUBLISHED" ||
      theme.processing ||
      theme.processingFailed
    )
      throw new CaptureContextError("context-mismatch");
    await dependencies.verifyThemeFiles(theme);
    if (
      (await dependencies.readCaptureContextSource(input.previewThemeId)) !== captureContextSource
    )
      throw new CaptureContextError("context-mismatch");
  };
  await check();
  const capture = await captureOraclePage(input, {
      ...dependencies,
      fetcher: async (url, init) => {
        const response = await (dependencies.fetcher ?? fetch)(url, init);
        if (!response.ok || response.redirected || (response.url && response.url !== String(url)))
          throw new CaptureContextError("invalid-payload");
        const reader = response.body?.getReader(),
          decoder = new TextDecoder("utf8", { fatal: true });
        if (!reader) throw new CaptureContextError("invalid-payload");
        let text = "",
          size = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 4 * 1024 * 1024) throw new CaptureContextError("invalid-payload");
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        return new Response(text, { status: response.status, headers: response.headers });
      },
      verifyThemeFiles: check,
      readIdentity: async () => {
        const identity = await dependencies.readIdentity();
        if (identity.id !== shopId) throw new CaptureContextError("context-mismatch");
        return identity;
      },
    }),
    end = Date.now(),
    contexts = capture.privateRawHtml.map(extractNativeCaptureContext);
  const first = contexts[0],
    second = contexts[1];
  if (!first || !second) throw new CaptureContextError("invalid-payload");
  await check();
  for (const value of [first, second]) {
    const time = Number(value.epoch) * 1000;
    if (
      value.shopId !== shopId.split("/").at(-1) ||
      value.domain !== input.config.domain ||
      value.path !== expectedPath ||
      time < start - 300000 ||
      time > end + 300000
    )
      throw new CaptureContextError("context-mismatch");
  }
  if (
    Number(second.epoch) < Number(first.epoch) ||
    !isDeepStrictEqual({ ...first, epoch: null }, { ...second, epoch: null })
  )
    throw new CaptureContextError("unstable-context");
  const receipt: VerifiedCaptureContext = Object.freeze({ kind: "verified-capture-context" });
  observations.set(receipt, {
    domain: input.config.domain,
    shopId,
    path: expectedPath,
    requestPath: input.path,
    previewThemeId: input.previewThemeId,
    snippetHash: captureContextHash,
    rawHashes: capture.privateRawHtml.map((html) =>
      createHash("sha256").update(html).digest("hex"),
    ),
    summaryHash: createHash("sha256").update(JSON.stringify(capture.publicSummary)).digest("hex"),
    sectionTextHash: createHash("sha256")
      .update(JSON.stringify(capture.privateSectionText))
      .digest("hex"),
    contexts: [first, second],
  });
  return {
    capture: { ...capture, capturedAt: new Date(Number(first.epoch) * 1000).toISOString() },
    context: receipt,
  };
}
/** Projects only same-response Native clock/cart context into an already calibrated snapshot. */
export function applyOracleCaptureContext(input: Snapshot, receipt: VerifiedCaptureContext) {
  const observed = inspectVerifiedCaptureContext(receipt),
    native = observed.contexts[0],
    snapshot = snapshotSchema.parse(input);
  if (
    (snapshot.shop.id !== undefined && snapshot.shop.id !== native.shopId) ||
    (snapshot.shop.permanentDomain !== undefined && snapshot.shop.permanentDomain !== native.domain)
  )
    throw new CaptureContextError("context-mismatch");
  if (
    snapshot.shop.currency !== native.cart.currency ||
    snapshot.shop.locale !== native.locale ||
    snapshot.cart.lines.length !== native.cart.items.length ||
    (snapshot.cart.note ?? "") !== (native.cart.note ?? "")
  )
    throw new CaptureContextError("context-mismatch");
  let total = 0n,
    count = 0;
  for (const [index, item] of native.cart.items.entries()) {
    const line = snapshot.cart.lines[index],
      product = snapshot.products.find((product) => product.handle === item.handle),
      variant = product?.variants.find((variant) => variant.id === item.variantId);
    if (
      !line ||
      !product ||
      !variant ||
      product.id !== item.productId ||
      line.productHandle !== item.handle ||
      line.variantId !== item.variantId ||
      line.key !== item.key ||
      line.quantity !== item.quantity ||
      item.parentRelationship !== null ||
      (item.itemComponents?.length ?? 0) > 0
    )
      throw new CaptureContextError("context-mismatch");
    const price = BigInt(liquidPrice(variant.price));
    if (
      BigInt(item.price) !== price ||
      item.originalPrice !== item.price ||
      item.finalPrice !== item.price ||
      BigInt(item.linePrice) !== price * BigInt(line.quantity) ||
      item.originalLinePrice !== item.linePrice ||
      item.finalLinePrice !== item.linePrice
    )
      throw new CaptureContextError("context-mismatch");
    total += BigInt(item.linePrice);
    count += line.quantity;
    line.instructions = item.instructions;
    line.parentRelationship = item.parentRelationship;
    line.itemComponents = item.itemComponents;
  }
  if (
    BigInt(native.cart.total) !== total ||
    BigInt(native.cart.originalTotal) !== total ||
    BigInt(native.cart.subtotal) !== total ||
    native.cart.discount !== 0 ||
    native.cart.itemCount !== count
  )
    throw new CaptureContextError("context-mismatch");
  snapshot.meta.now = new Date(Number(native.epoch) * 1000).toISOString();
  snapshot.shop.id = native.shopId;
  snapshot.shop.permanentDomain = native.domain;
  snapshot.cart.note = native.cart.note;
  snapshot.cart.taxesIncluded = native.cart.taxesIncluded;
  snapshot.cart.dutiesIncluded = native.cart.dutiesIncluded;
  validateSnapshotReferences(snapshot);
  return {
    snapshot,
    captureReady: false as const,
    omissions: ["all-state-fixture-assembly", "owned-resource-and-image-receipts"],
  };
}
