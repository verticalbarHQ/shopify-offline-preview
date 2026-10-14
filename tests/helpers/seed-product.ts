import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultFixture } from "../../packages/data/src/fixture.js";
import { backupDigest } from "../../tools/oracle/backup-audit.js";
import { createOracleSeedBindingLedger } from "../../tools/oracle/seed-binding-ledger.js";
import { createOracleSeedExecutor } from "../../tools/oracle/seed-execution.js";
import {
  createOracleSeedGeneratedRecorder,
  SeedGeneratedError,
} from "../../tools/oracle/seed-generated.js";
import { buildOracleSeedPlan } from "../../tools/oracle/seed-plan.js";
import { seedBindingKey } from "../../tools/oracle/seed-requests.js";
import { createOracleSeedUploader } from "../../tools/oracle/seed-upload.js";

const allContracts: unknown = JSON.parse(
  await readFile(
    new URL("../fixtures/oracle-seed-all-input-contracts.json", import.meta.url),
    "utf8",
  ),
);

// Authored GraphQL responses only. Test authorization callbacks are not real owner approval.
export const config = { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" as const },
  shopId = "gid://shopify/Shop/1",
  locationId = "gid://shopify/Location/1",
  productLegacy = "9007199254740993",
  productId = `gid://shopify/Product/${productLegacy}`,
  createdAt = "2026-10-15T01:23:45Z",
  shop = { id: shopId, myshopifyDomain: config.domain, plan: { partnerDevelopment: true } },
  contracts: unknown = JSON.parse(
    await readFile(
      new URL("../fixtures/oracle-seed-input-contracts.json", import.meta.url),
      "utf8",
    ),
  ),
  code = (name: string) => (error: unknown) =>
    error instanceof SeedGeneratedError && error.code === name,
  reply = (data: unknown, version = "2026-10") =>
    Response.json({ data }, { headers: { "x-shopify-api-version": version } });
export function setup(withImage = false) {
  const snapshot = defaultFixture();
  const firstImage = snapshot.products[0]?.images[0],
    imageId = "gid://shopify/MediaImage/55",
    imageUrl = "https://cdn.shopify.com/s/files/1/files/authored.png?v=1",
    imageBytes = new Uint8Array([1, 2, 3]);
  for (const p of snapshot.products) {
    p.images = [];
    for (const v of p.variants) v.image = null;
  }
  const source = snapshot.products[0];
  assert.ok(source);
  if (withImage) {
    assert.ok(firstImage);
    source.images = [{ ...firstImage }];
    const variant = source.variants[0];
    assert.ok(variant);
    variant.image = firstImage.file;
  }
  const plan = buildOracleSeedPlan(config, snapshot),
    state = plan.states[0];
  assert.ok(state);
  const task = state.tasks.find((t) => t.resource === "product");
  assert.ok(task);
  const variants = source.variants.map((v, index) => ({
      id: `gid://shopify/ProductVariant/${BigInt(productLegacy) + BigInt(index + 1)}`,
      legacyResourceId: String(BigInt(productLegacy) + BigInt(index + 1)),
      selectedOptions: v.optionValues,
    })),
    parent = { id: productId, handle: source.handle, tags: source.tags };
  let reads = 0,
    writes = 0,
    change = false,
    foreign = false,
    badContent = false;
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") return new Response(imageBytes);
    const body = JSON.parse(String(init?.body)),
      query = String(body.query);
    if (query.includes("OfflinePreviewSeedGuard"))
      return reply({
        shop: {
          ...shop,
          name: "Authored shop",
          currencyCode: "USD",
          ianaTimezone: "UTC",
          metafield: { value: "true" },
        },
        currentAppInstallation: {
          accessScopes: [
            "write_products",
            "write_inventory",
            "read_locations",
            ...(withImage ? ["write_files"] : []),
          ].map((handle) => ({
            handle,
          })),
        },
      });
    if (query.includes("OfflinePreviewSeedAbsence"))
      return reply({
        shop,
        products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
    if (query.includes("OfflinePreviewSeedIdentities"))
      return reply({
        shop,
        nodes: body.variables.ids.map((id: string) =>
          id === imageId && firstImage
            ? {
                __typename: "MediaImage",
                id,
                alt: firstImage.alt,
                fileStatus: "READY",
                image: { url: imageUrl, width: firstImage.width, height: firstImage.height },
                originalSource: {
                  url: "https://cdn.shopify.com/original.png",
                  fileSize: imageBytes.length,
                },
              }
            : id === "gid://shopify/Publication/1"
              ? {
                  __typename: "Publication",
                  id,
                  catalog: {
                    __typename: "AppCatalog",
                    id: "gid://shopify/AppCatalog/1",
                    apps: {
                      nodes: [{ id: "gid://shopify/App/1" }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                }
              : id === locationId
                ? { __typename: "Location", id, isActive: true }
                : id === productId
                  ? { __typename: "Product", ...parent }
                  : {
                      __typename: "ProductVariant",
                      ...variants.find((v) => v.id === id),
                      product: parent,
                    },
        ),
      });
    if (query.includes("OfflinePreviewSeedVariants"))
      return reply({
        shop,
        product: {
          ...parent,
          variants: {
            nodes: variants.map((v) => ({ __typename: "ProductVariant", ...v })),
            pageInfo: { hasNextPage: false },
          },
        },
      });
    if (query.includes("OfflinePreviewSeedGenerated")) {
      reads++;
      return reply({
        shop,
        nodes: [
          {
            __typename: "Product",
            ...parent,
            legacyResourceId: productLegacy,
            createdAt: change && reads % 2 === 0 ? "2026-10-15T01:23:46Z" : createdAt,
            publishedAt: null,
            variants: {
              nodes: variants.map((v, i) =>
                foreign && i === 0
                  ? { ...v, id: "gid://shopify/ProductVariant/99", legacyResourceId: "99" }
                  : v,
              ),
              pageInfo: { hasNextPage: false },
            },
          },
        ],
      });
    }
    if (query.includes("OfflinePreviewSeedPublication"))
      return reply({
        shop,
        nodes: [
          { __typename: "Product", ...parent, status: "ACTIVE", publishedOnPublication: true },
        ],
      });
    if (query.includes("OfflinePreviewSeedSource"))
      return reply({
        shop,
        nodes: [
          {
            __typename: "Product",
            ...parent,
            title: badContent ? "changed" : source.title,
            templateSuffix: source.templateSuffix,
            descriptionHtml: source.descriptionHtml,
            vendor: source.vendor,
            productType: source.productType,
            status: "ACTIVE",
            seo: source.seo,
            category: null,
            isGiftCard: false,
            requiresSellingPlan: false,
            options: source.options.map((o, index) => ({
              name: o.name,
              position: index + 1,
              optionValues: o.values.map((name) => ({ name })),
            })),
            media: {
              nodes: source.images.map((image) => ({
                __typename: "MediaImage",
                id: imageId,
                alt: image.alt,
                fileStatus: "READY",
                image: {
                  url: imageUrl,
                  altText: image.alt,
                  width: image.width,
                  height: image.height,
                },
              })),
              pageInfo: { hasNextPage: false },
            },
            variants: {
              nodes: source.variants.map((v, index) => ({
                id: variants[index]?.id,
                position: index + 1,
                selectedOptions: v.optionValues,
                price: v.price,
                compareAtPrice: v.compareAtPrice,
                sku: v.sku,
                taxable: v.taxable,
                inventoryPolicy: v.inventoryPolicy === "deny" ? "DENY" : "CONTINUE",
                inventoryQuantity: v.inventoryQuantity,
                barcodes: {
                  nodes: v.barcode ? [{ value: v.barcode, type: null }] : [],
                  pageInfo: { hasNextPage: false },
                },
                media: {
                  nodes: v.image ? [{ __typename: "MediaImage", id: imageId }] : [],
                  pageInfo: { hasNextPage: false },
                },
                inventoryItem: {
                  id: `gid://shopify/InventoryItem/${index + 1}`,
                  sku: v.sku,
                  tracked: true,
                  requiresShipping: v.requiresShipping,
                  measurement: { weight: { value: v.weight, unit: "GRAMS" } },
                  inventoryLevel: {
                    isActive: true,
                    location: { id: locationId },
                    quantities: [{ name: "available", quantity: v.inventoryQuantity }],
                  },
                },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        ],
      });
    assert.ok(query.startsWith("mutation "));
    writes++;
    if (query.includes("stagedUploadsCreate"))
      return reply({
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: "https://shopify-staged-uploads.storage.googleapis.com/",
              resourceUrl: "https://shopify-staged-uploads.storage.googleapis.com/tmp/authored.png",
              parameters: [{ name: "key", value: "tmp/authored.png" }],
            },
          ],
          userErrors: [],
        },
      });
    if (query.includes("fileCreate"))
      return reply({ fileCreate: { files: [{ id: imageId }], userErrors: [] } });
    return reply({ productSet: { product: { id: productId }, userErrors: [] } });
  };
  const assets =
      withImage && firstImage
        ? [{ file: firstImage.file, bytes: imageBytes.length, sha256: backupDigest(imageBytes) }]
        : [],
    retained = withImage ? allContracts : contracts,
    ledger = createOracleSeedBindingLedger(config, snapshot, shopId, "authored", assets, fetcher),
    executor = createOracleSeedExecutor(config, snapshot, shopId, "authored", retained, {
      authorize: async () => {},
      verifyResult: async () => {},
      verifyBindings: ledger.verifyBindings,
      fetcher,
    }),
    recorder = createOracleSeedGeneratedRecorder(
      config,
      snapshot,
      shopId,
      "authored",
      ledger,
      fetcher,
    );
  const step = {
    stateHash: state.hash,
    taskKey: task.key,
    kind: "task" as const,
    options: { mode: "create" as const },
    bindings: {
      '["inventory-location"]': locationId,
      ...(withImage && firstImage
        ? { [seedBindingKey("image-id", firstImage.file)]: imageId }
        : {}),
    },
  };
  return {
    snapshot,
    source,
    plan,
    state,
    task,
    ledger,
    executor,
    recorder,
    variants,
    step,
    fetcher,
    assets,
    retained,
    imageBytes,
    image: firstImage,
    imageId,
    imageUrl,
    seedImage: async () => {
      if (!firstImage || !withImage) throw new Error();
      const task = state.tasks.find(
        (task) => task.resource === "image" && task.identity[0] === firstImage.file,
      );
      assert.ok(task);
      const base = {
          stateHash: state.hash,
          taskKey: task.key,
          kind: "task" as const,
          options: { mode: "create" as const, imageBytes: imageBytes.length },
          bindings: {},
        },
        staged = await executor.executeVerified(base),
        uploader = createOracleSeedUploader(config, snapshot, shopId, assets, {
          authorize: async () => {},
          fetcher: async () => new Response(null, { status: 204 }),
        });
      ledger.recordUpload(await uploader.upload(staged, imageBytes));
      await ledger.record(
        await executor.executeVerified({
          ...base,
          requestIndex: 1,
          bindings: {
            [seedBindingKey("staged-image-url", firstImage.file)]: ledger.get(
              seedBindingKey("staged-image-url", firstImage.file),
            ),
          },
        }),
      );
    },
    reads: () => reads,
    writes: () => writes,
    set: (failure: "change" | "foreign" | "content") => {
      change = failure === "change";
      foreign = failure === "foreign";
      badContent = failure === "content";
    },
  };
}
