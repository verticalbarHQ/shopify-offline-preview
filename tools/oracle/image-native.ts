import { isDeepStrictEqual } from "node:util";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import {
  type CompleteSnapshot as Snapshot,
  completeSnapshotSchema as snapshotSchema,
} from "../../packages/data/src/schema.js";
import { oracleThemeSchema } from "./admin-read.js";
import { type CaptureDependencies, captureOracleHtmlPair } from "./capture.js";
import { type CorpusFiles, corpusFilesFingerprint } from "./corpus-environment.js";
import type { createOracleSeedBindingLedger } from "./seed-binding-ledger.js";
import { readOracleSeedGeneratedMetadata } from "./seed-generated.js";
import { buildOracleSeedPlan } from "./seed-plan.js";
import { seedBindingKey } from "./seed-requests.js";
import { createOracleSeedStateReader } from "./seed-state-reader.js";
import { assertOracleStore, type OracleConfig, oracleConfigSchema } from "./store-guard.js";

type Kind = "product" | "collection" | "article";
export class NativeImageError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "scope-mismatch"
      | "files-mismatch"
      | "payload-invalid"
      | "source-mismatch"
      | "unstable-observation"
      | "observation-failed"
      | "unverified-observation",
  ) {
    super(`Native image observation failed: ${code}`);
    this.name = "NativeImageError";
  }
}
function liquidImage(variable: string, preview = false): string {
  const identifier = (path: string) =>
      `{% if ${path} == nil %}null{% else %}{{${path} | append: '' | json}}{% endif %}`,
    fields = `"id":${identifier(`${variable}.id`)},"src":{{${variable}.src | json}},"alt":{{${variable}.alt | json}},"width":{{${variable}.width | json}},"height":{{${variable}.height | json}},"position":{{${variable}.position | json}},"productId":${identifier(`${variable}.product_id`)},"mediaType":{{${variable}.media_type | json}},"attached":{{${variable}.attached_to_variant? | json}},"variants":{% if ${variable}.variants == nil %}null{% else %}[{% for sop_iv in ${variable}.variants %}{{sop_iv.id | append: '' | json}}{% unless forloop.last %},{% endunless %}{% endfor %}]{% endif %}`;
  return `{${fields}${preview ? "" : `,"preview":{% if ${variable}.preview_image == nil %}null{% else %}${liquidImage(`${variable}.preview_image`, true)}{% endif %}`}}`;
}
/** Authored expressions only: no expected IDs, image values or theme source are embedded. */
export function prepareNativeImageProbe(kind: Kind) {
  if (!["product", "collection", "article"].includes(kind))
    throw new NativeImageError("invalid-input");
  const key = `sop-image-views-v1-${kind}`,
    images =
      kind === "product"
        ? `[{% for sop_i in product.images %}${liquidImage("sop_i")}{% unless forloop.last %},{% endunless %}{% endfor %}]`
        : `[{% if ${kind}.image != nil %}${liquidImage(`${kind}.image`)}{% endif %}]`,
    liquid = `{% capture sop_image_observation %}{"shopId":{{shop.id | append: '' | json}},"permanentDomain":{{shop.permanent_domain | json}},"kind":"${kind}","parentId":{{${kind}.id | append: '' | json}},"handle":{{${kind}.handle | json}},"images":${images},"media":[${kind === "product" ? `{% for sop_m in product.media %}${liquidImage("sop_m")}{% unless forloop.last %},{% endunless %}{% endfor %}` : ""}],"variants":[${kind === "product" ? `{% for sop_v in product.variants %}{"id":{{sop_v.id | append: '' | json}},"imageId":{% if sop_v.image == nil %}null{% else %}{{sop_v.image.id | append: '' | json}}{% endif %},"mediaId":{% if sop_v.featured_media == nil %}null{% else %}{{sop_v.featured_media.id | append: '' | json}}{% endif %}}{% unless forloop.last %},{% endunless %}{% endfor %}` : ""}]}{% endcapture %}<script id="${key}" type="application/json">{{sop_image_observation | base64_encode | json}}</script>`,
    layout =
      "<!doctype html><html><head>{{content_for_header}}</head><body>{{content_for_layout}}</body></html>",
    files: CorpusFiles = {
      "layout/theme.liquid": layout,
      [`layout/${key}.liquid`]: layout,
      [`sections/${key}.liquid`]: liquid,
      [`templates/${kind}.${key}.json`]: JSON.stringify({
        layout: key,
        sections: { main: { type: key } },
        order: ["main"],
      }),
    };
  return { kind, key, files, harnessHash: corpusFilesFingerprint(files) };
}
export type PreparedNativeImageProbe = ReturnType<typeof prepareNativeImageProbe>;
const numericId = z.string().regex(/^[1-9]\d*$/),
  fields = {
    id: numericId.nullable(),
    src: z.string().max(16384),
    alt: z.string().nullable(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    position: z.number().int().positive().nullable(),
    productId: numericId.nullable(),
    mediaType: z.string().nullable(),
    attached: z.boolean().nullable(),
    variants: z.array(numericId).max(250).nullable(),
  },
  row = z.strictObject({ ...fields, preview: z.strictObject(fields).nullable() }),
  payloadSchema = z.strictObject({
    shopId: numericId,
    permanentDomain: z.string(),
    kind: z.enum(["product", "collection", "article"]),
    parentId: numericId,
    handle: z.string(),
    images: z.array(row).max(250),
    media: z.array(row).max(250),
    variants: z
      .array(
        z.strictObject({
          id: numericId,
          imageId: numericId.nullable(),
          mediaId: numericId.nullable(),
        }),
      )
      .max(250),
  });
export type NativeImagePayload = z.infer<typeof payloadSchema>;
export function extractNativeImagePayload(
  html: string,
  probe: PreparedNativeImageProbe,
): NativeImagePayload {
  const expected = prepareNativeImageProbe(probe.kind);
  if (
    probe.key !== expected.key ||
    probe.harnessHash !== expected.harnessHash ||
    corpusFilesFingerprint(probe.files) !== expected.harnessHash ||
    Buffer.byteLength(html) > 2 * 1024 * 1024
  )
    throw new NativeImageError("payload-invalid");
  const found: string[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some((attr) => attr.name === "id" && attr.value === expected.key)
    ) {
      if (!node.attrs.some((attr) => attr.name === "type" && attr.value === "application/json"))
        throw new Error();
      found.push(node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""));
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  try {
    visit(parse(html));
    if (found.length !== 1) throw new Error();
    const encoded = z.string().parse(JSON.parse(found[0] ?? "")),
      bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > 1024 * 1024) throw new Error();
    const value = payloadSchema.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
    );
    if (value.kind !== probe.kind) throw new Error();
    return value;
  } catch {
    throw new NativeImageError("payload-invalid");
  }
}
function assetKey(value: string, domain: string) {
  const url = new URL(value, `https://${domain}`);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    ![domain, "cdn.shopify.com", "shopify-shop-assets.storage.googleapis.com"].includes(
      url.hostname,
    ) ||
    [...url.searchParams].some(([key, value]) => key !== "v" || !/^\d+$/.test(value))
  )
    throw new Error();
  const offset = Math.max(
    url.pathname.lastIndexOf("/files/"),
    url.pathname.lastIndexOf("/products/"),
    url.pathname.lastIndexOf("/collections/"),
    url.pathname.lastIndexOf("/articles/"),
  );
  if (offset < 0) throw new Error();
  return decodeURIComponent(url.pathname.slice(offset + 1));
}
export interface VerifiedNativeImages {
  readonly kind: "verified-native-images";
}
interface Observation {
  domain: string;
  shopId: string;
  fixtureHash: string;
  stateHash: string;
  taskKey: string;
  sourceHash: string;
  payload: NativeImagePayload;
}
const observations = new WeakMap<VerifiedNativeImages, Observation>();
export function inspectVerifiedNativeImages(receipt: VerifiedNativeImages): Observation {
  const value = observations.get(receipt);
  if (!value) throw new NativeImageError("unverified-observation");
  return structuredClone(value);
}
export interface NativeImageDependencies extends CaptureDependencies {
  readThemeFiles(id: string, paths: readonly string[]): Promise<CorpusFiles>;
}

/** Reads an already uploaded, verified unpublished probe. This never uploads files or mutates the store. */
export function createOracleNativeImageRecorder(
  inputConfig: OracleConfig,
  input: Snapshot,
  shopId: string,
  token: string,
  ledger: ReturnType<typeof createOracleSeedBindingLedger>,
  dependencies: NativeImageDependencies,
  adminFetcher: typeof fetch = fetch,
) {
  const config = oracleConfigSchema.parse(inputConfig),
    snapshot = snapshotSchema.parse(input),
    plan = buildOracleSeedPlan(config, snapshot),
    stateReader = createOracleSeedStateReader(config, snapshot, shopId, token, ledger, {
      fetcher: adminFetcher,
    });
  if (plan.issues.length || typeof dependencies.readThemeFiles !== "function")
    throw new NativeImageError("invalid-input");
  let busy = false;
  return {
    async observe(
      stateHash: string,
      taskKey: string,
      themeId: string,
      cookie: string,
    ): Promise<VerifiedNativeImages> {
      if (busy) throw new NativeImageError("observation-failed");
      busy = true;
      try {
        const task = plan.states
          .find((state) => state.hash === stateHash)
          ?.tasks.find((task) => task.key === taskKey);
        if (
          !task ||
          (task.resource !== "product" &&
            task.resource !== "collection" &&
            task.resource !== "article")
        )
          throw new NativeImageError("scope-mismatch");
        const kind = task.resource,
          ownership = await ledger.observeOwnedTask(stateHash, taskKey),
          root = await ledger.assertOwned(ownership),
          metadataKind =
            kind === "product" ? "Product" : kind === "collection" ? "Collection" : "Article";
        await stateReader.verifyTask(stateHash, taskKey);
        if (
          (kind === "product" || kind === "collection") &&
          !(await stateReader.publication(stateHash, taskKey))
        )
          throw new Error();
        const before = await readOracleSeedGeneratedMetadata(
            config,
            token,
            shopId,
            metadataKind,
            root.id,
            adminFetcher,
          ),
          source =
            kind === "product"
              ? snapshotSchema.shape.products.element.parse(task.source).images
              : kind === "collection"
                ? [snapshotSchema.shape.collections.element.parse(task.source).image].filter(
                    (value) => value !== null,
                  )
                : [
                    snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source)
                      .image,
                  ].filter((value) => value !== null),
          expectedUrls = new Map<string, string>();
        for (const image of source) {
          const owned = await ledger.verifyExpected(seedBindingKey("image-id", image.file), true);
          if (owned.kind !== "MediaImage") throw new Error();
          expectedUrls.set(image.file, assetKey(owned.url, config.domain));
        }
        const probe = prepareNativeImageProbe(kind),
          route =
            kind === "article"
              ? `/blogs/${encodeURIComponent(task.identity[0] ?? "")}/${encodeURIComponent(task.identity[1] ?? "")}`
              : `/${kind === "product" ? "products" : "collections"}/${encodeURIComponent(task.identity[0] ?? "")}`,
          checkFiles = async () => {
            const identity = await dependencies.readIdentity(),
              theme = oracleThemeSchema.parse(await dependencies.readTheme(themeId));
            assertOracleStore(config, identity);
            if (
              identity.id !== shopId ||
              theme.id !== `gid://shopify/OnlineStoreTheme/${themeId}` ||
              theme.role !== "UNPUBLISHED" ||
              theme.processing ||
              theme.processingFailed
            )
              throw new NativeImageError("scope-mismatch");
            if (
              corpusFilesFingerprint(
                await dependencies.readThemeFiles(themeId, Object.keys(probe.files).sort()),
              ) !== probe.harnessHash
            )
              throw new NativeImageError("files-mismatch");
          },
          pair = await captureOracleHtmlPair(
            { config, path: `${route}?view=${probe.key}`, previewThemeId: themeId, cookie },
            {
              ...dependencies,
              readIdentity: async () => {
                const identity = await dependencies.readIdentity();
                if (identity.id !== shopId) throw new NativeImageError("scope-mismatch");
                return identity;
              },
              fetcher: async (url, init) => {
                const response = await (dependencies.fetcher ?? fetch)(url, init);
                if (
                  !response.ok ||
                  response.redirected ||
                  (response.url && response.url !== String(url))
                )
                  throw new NativeImageError("observation-failed");
                const reader = response.body?.getReader(),
                  decoder = new TextDecoder("utf8", { fatal: true });
                if (!reader) throw new NativeImageError("payload-invalid");
                let body = "",
                  length = 0;
                try {
                  for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    length += chunk.value.byteLength;
                    if (length > 2 * 1024 * 1024) throw new NativeImageError("payload-invalid");
                    body += decoder.decode(chunk.value, { stream: true });
                  }
                  body += decoder.decode();
                } finally {
                  await reader.cancel();
                  reader.releaseLock();
                }
                return new Response(body, { status: response.status, headers: response.headers });
              },
              verifyThemeFiles: async (theme) => {
                if (theme.id !== `gid://shopify/OnlineStoreTheme/${themeId}`) throw new Error();
                await checkFiles();
              },
            },
          ),
          first = extractNativeImagePayload(pair.privateRawHtml[0], probe),
          second = extractNativeImagePayload(pair.privateRawHtml[1], probe);
        await checkFiles();
        const after = await readOracleSeedGeneratedMetadata(
          config,
          token,
          shopId,
          metadataKind,
          root.id,
          adminFetcher,
        );
        await stateReader.verifyTask(stateHash, taskKey);
        await ledger.assertOwned(ownership);
        if (
          (kind === "product" || kind === "collection") &&
          !(await stateReader.publication(stateHash, taskKey))
        )
          throw new NativeImageError("source-mismatch");
        if (!isDeepStrictEqual(first, second) || !isDeepStrictEqual(before, after))
          throw new NativeImageError("unstable-observation");
        const parentId =
            before.__typename === "Product" || before.__typename === "Collection"
              ? before.legacyResourceId
              : before.id.slice(before.id.lastIndexOf("/") + 1),
          handle = task.identity[kind === "article" ? 1 : 0];
        if (
          first.shopId !== shopId.slice(shopId.lastIndexOf("/") + 1) ||
          first.permanentDomain !== config.domain ||
          first.parentId !== parentId ||
          first.handle !== handle ||
          first.kind !== kind ||
          first.images.length !== source.length
        )
          throw new NativeImageError("source-mismatch");
        for (const [index, image] of source.entries()) {
          const classic = first.images[index];
          if (
            !classic ||
            assetKey(classic.src, config.domain) !== expectedUrls.get(image.file) ||
            classic.alt !== image.alt ||
            classic.width !== image.width ||
            classic.height !== image.height ||
            classic.mediaType !== null ||
            classic.preview !== null
          )
            throw new NativeImageError("source-mismatch");
          if (kind === "product") {
            const media = first.media[index],
              variants = snapshotSchema.shape.products.element.parse(task.source).variants,
              expectedVariants = variants
                .filter((variant) => variant.image === image.file)
                .map((variant) =>
                  ledger
                    .get(seedBindingKey("variant-id", task.identity[0] ?? "", variant.id))
                    .split("/")
                    .at(-1),
                );
            if (
              !classic.id ||
              classic.position !== index + 1 ||
              classic.productId !== parentId ||
              classic.attached !== expectedVariants.length > 0 ||
              !isDeepStrictEqual(classic.variants, expectedVariants) ||
              !media?.id ||
              media.mediaType !== "image" ||
              media.position !== index + 1 ||
              media.productId !== null ||
              media.attached !== null ||
              media.variants !== null ||
              !media.preview ||
              media.preview.id !== null ||
              media.preview.position !== null ||
              media.preview.productId !== null ||
              media.preview.mediaType !== null ||
              media.preview.attached !== null ||
              media.preview.variants !== null ||
              assetKey(media.src, config.domain) !== expectedUrls.get(image.file) ||
              assetKey(media.preview.src, config.domain) !== expectedUrls.get(image.file) ||
              media.width !== image.width ||
              media.height !== image.height ||
              media.preview.width !== image.width ||
              media.preview.height !== image.height
            )
              throw new NativeImageError("source-mismatch");
          } else if (
            classic.position !== null ||
            classic.productId !== null ||
            classic.attached !== null ||
            classic.variants !== null
          )
            throw new NativeImageError("source-mismatch");
        }
        if (kind === "product") {
          const product = snapshotSchema.shape.products.element.parse(task.source);
          if (
            first.media.length !== source.length ||
            first.variants.length !== product.variants.length
          )
            throw new NativeImageError("source-mismatch");
          for (const variant of product.variants) {
            const numeric = ledger
                .get(seedBindingKey("variant-id", product.handle, variant.id))
                .split("/")
                .at(-1),
              actual = first.variants.find((row) => row.id === numeric),
              index = product.images.findIndex((image) => image.file === variant.image);
            if (
              !actual ||
              actual.imageId !== (index < 0 ? null : first.images[index]?.id) ||
              actual.mediaId !== (index < 0 ? null : first.media[index]?.id)
            )
              throw new NativeImageError("source-mismatch");
          }
          if (
            new Set(first.images.map((row) => row.id)).size !== first.images.length ||
            new Set(first.media.map((row) => row.id)).size !== first.media.length ||
            new Set(first.variants.map((row) => row.id)).size !== first.variants.length
          )
            throw new NativeImageError("source-mismatch");
        } else if (first.media.length || first.variants.length)
          throw new NativeImageError("source-mismatch");
        const receipt: VerifiedNativeImages = Object.freeze({ kind: "verified-native-images" });
        observations.set(receipt, {
          domain: config.domain,
          shopId,
          fixtureHash: plan.fixtureHash,
          stateHash,
          taskKey,
          sourceHash: task.sourceHash,
          payload: first,
        });
        return receipt;
      } catch (error) {
        if (error instanceof NativeImageError) throw error;
        throw new NativeImageError("observation-failed");
      } finally {
        busy = false;
      }
    },
  };
}

/** Patch source-scoped readonly IDs/view alt metadata into an already generated-field-calibrated case. */
export function applyOracleNativeImages(
  config: OracleConfig,
  original: Snapshot,
  shopId: string,
  caseId: string,
  derived: Snapshot,
  receipts: readonly VerifiedNativeImages[],
) {
  const plan = buildOracleSeedPlan(config, original),
    request = plan.requests.find((request) => request.caseId === caseId),
    state = plan.states.find((state) => state.hash === request?.stateHash),
    snapshot = snapshotSchema.parse(derived),
    seen = new Set<string>();
  if (!state || plan.issues.length) throw new NativeImageError("invalid-input");
  for (const receipt of receipts) {
    const observed = inspectVerifiedNativeImages(receipt),
      task = state.tasks.find((task) => task.key === observed.taskKey);
    if (
      !task ||
      observed.domain !== config.domain ||
      observed.shopId !== shopId ||
      observed.fixtureHash !== plan.fixtureHash ||
      observed.stateHash !== state.hash ||
      observed.sourceHash !== task.sourceHash ||
      seen.has(task.key)
    )
      throw new NativeImageError("scope-mismatch");
    seen.add(task.key);
    const parent =
      task.resource === "product"
        ? snapshot.products.find((product) => product.handle === task.identity[0])
        : task.resource === "collection"
          ? snapshot.collections.find((collection) => collection.handle === task.identity[0])
          : snapshot.blogs
              .find((blog) => blog.handle === task.identity[0])
              ?.articles.find((article) => article.handle === task.identity[1]);
    if (!parent || parent.id !== observed.payload.parentId)
      throw new NativeImageError("source-mismatch");
    if (task.resource === "product") {
      const product = snapshot.products.find((product) => product.handle === task.identity[0]);
      if (
        !product ||
        product.variants.length !== observed.payload.variants.length ||
        product.variants.some((variant) => {
          const actual = observed.payload.variants.find((row) => row.id === variant.id),
            imageIndex = product.images.findIndex((image) => image.file === variant.image);
          return (
            !actual ||
            actual.imageId !== (imageIndex < 0 ? null : observed.payload.images[imageIndex]?.id) ||
            actual.mediaId !== (imageIndex < 0 ? null : observed.payload.media[imageIndex]?.id)
          );
        })
      )
        throw new NativeImageError("source-mismatch");
    }
    const target =
        task.resource === "product"
          ? snapshot.products.find((product) => product.handle === task.identity[0])?.images
          : task.resource === "collection"
            ? [
                snapshot.collections.find((collection) => collection.handle === task.identity[0])
                  ?.image,
              ].filter((value) => value != null)
            : [
                snapshot.blogs
                  .find((blog) => blog.handle === task.identity[0])
                  ?.articles.find((article) => article.handle === task.identity[1])?.image,
              ].filter((value) => value != null),
      source =
        task.resource === "product"
          ? snapshotSchema.shape.products.element.parse(task.source).images
          : task.resource === "collection"
            ? [snapshotSchema.shape.collections.element.parse(task.source).image].filter(
                (value) => value !== null,
              )
            : [
                snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source).image,
              ].filter((value) => value !== null);
    if (!target || target.length !== source.length) throw new NativeImageError("source-mismatch");
    for (const [index, image] of target.entries()) {
      const expected = source[index],
        native = observed.payload.images[index];
      if (
        !expected ||
        !native ||
        image.file !== expected.file ||
        image.alt !== expected.alt ||
        image.width !== expected.width ||
        image.height !== expected.height
      )
        throw new NativeImageError("source-mismatch");
      image.id = native.id;
      if (task.resource === "product") {
        const product = snapshot.products.find((product) => product.handle === task.identity[0]),
          productImage = product?.images[index],
          media = observed.payload.media[index];
        if (!productImage || !media?.id || !media.preview)
          throw new NativeImageError("source-mismatch");
        productImage.mediaId = media.id;
        productImage.mediaAlt = media.alt;
        productImage.previewAlt = media.preview.alt;
      }
    }
  }
  return {
    snapshot,
    missingTasks: state.tasks
      .filter(
        (task) =>
          ["product", "collection", "article"].includes(task.resource) && !seen.has(task.key),
      )
      .map((task) => task.key),
    captureReady: false as const,
  };
}
