import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { defaultFixture } from "../../packages/data/src/fixture.js";
import { snapshotSchema } from "../../packages/data/src/schema.js";
import { backupDigest } from "../../tools/oracle/backup-audit.js";
import { captureContextKey, captureContextSource } from "../../tools/oracle/capture-context.js";
import {
  type NativeImagePayload,
  prepareNativeImageProbe,
} from "../../tools/oracle/image-native.js";
import { buildOracleSeedPlan } from "../../tools/oracle/seed-plan.js";
import { config, locationId, shopId } from "./seed-product.js";

export { config, locationId, shopId };
export const publication = {
  kind: "Publication" as const,
  id: "gid://shopify/Publication/1",
  catalogId: "gid://shopify/AppCatalog/1",
  appId: "gid://shopify/App/1",
};
export const allContracts: unknown = JSON.parse(
  await readFile(
    new URL("../fixtures/oracle-seed-all-input-contracts.json", import.meta.url),
    "utf8",
  ),
);
/** Authored HTTP model only. Even full release inputs do not make its responses real Shopify evidence. */
function authoredCaseStore(options: { genericImages?: boolean; fullFixture?: boolean } = {}) {
  const snapshot = defaultFixture();
  if (!options.fullFixture) {
    snapshot.products = snapshot.products.slice(0, 2);
    for (const product of snapshot.products) {
      const variant = product.variants[0];
      assert.ok(variant);
      product.images = [];
      product.options = [{ name: "Title", values: ["Default Title"] }];
      product.variants = [
        {
          ...variant,
          image: null,
          available: true,
          optionValues: [{ name: "Title", value: "Default Title" }],
        },
      ];
    }
    snapshot.collections = snapshot.collections.slice(0, 1);
    for (const collection of snapshot.collections) {
      if (!options.genericImages) collection.image = null;
      collection.products = snapshot.products.map((product) => product.handle);
      collection.sortOrder = "manual";
    }
    snapshot.pages = snapshot.pages.slice(0, 1);
    snapshot.blogs = snapshot.blogs.filter((blog) => blog.handle === "news");
    for (const blog of snapshot.blogs) {
      blog.articles = blog.articles.slice(0, 1);
      for (const article of blog.articles) if (!options.genericImages) article.image = null;
    }
    snapshot.menus = [
      {
        handle: "main-menu",
        title: "Main menu",
        links: [{ title: "Home", url: "/", type: "http_link", resourceHandle: null, links: [] }],
      },
    ];
    snapshot.images = [];
    snapshot.metaobjects = [];
    snapshot.filters = [];
    snapshot.cart = { lines: [], note: "", taxesIncluded: false, dutiesIncluded: false };
    for (const name of Object.keys(snapshot.scenarios)) snapshot.scenarios[name] = {};
    snapshot.scenarios["with-items"] = {
      cart: {
        lines: snapshot.products.map((product) => ({
          productHandle: product.handle,
          variantId: product.variants[0]?.id ?? "",
          quantity: 1,
        })),
        note: "Authored case note",
      },
    };
  }
  const plan = buildOracleSeedPlan(config, snapshot),
    state = plan.states[0];
  assert.ok(state);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.states.length, options.fullFixture ? 7 : 1);
  const tasks = [...state.tasks];
  let desiredTasks = state.tasks;
  const ids = new Map(
      tasks.map((task, index) => [
        task.key,
        `gid://shopify/${task.resource === "image" ? "MediaImage" : `${task.resource[0]?.toUpperCase()}${task.resource.slice(1)}`}/${100 + index}`,
      ]),
    ),
    created = new Set<string>(),
    published = new Set<string>(),
    mutations = new Map<string, number>(),
    variants = new Map<string, { id: string; parent: string; index: number }>();
  const imageBytes = new Map(
      tasks
        .filter((task) => task.resource === "image")
        .map((task) => {
          const file = task.identity[0];
          assert.ok(file);
          return [
            file,
            options.fullFixture
              ? new Uint8Array(
                  readFileSync(new URL(`../../fixtures/default/images/${file}`, import.meta.url)),
                )
              : new Uint8Array([1, 2, 3]),
          ] as const;
        }),
    ),
    bytesFor = (file: string) => {
      const bytes = imageBytes.get(file);
      assert.ok(bytes);
      return bytes;
    },
    assets = tasks
      .filter((task) => task.resource === "image")
      .map((task) => ({
        file: task.identity[0] ?? "",
        bytes: bytesFor(task.identity[0] ?? "").length,
        sha256: backupDigest(bytesFor(task.identity[0] ?? "")),
      })),
    imageUrl = (file: string) => `https://cdn.shopify.com/s/files/1/files/${file}?v=1`,
    adminImage = (image: (typeof snapshot.collections)[number]["image"]) =>
      image
        ? {
            url: imageUrl(image.file),
            altText: image.alt,
            width: image.width,
            height: image.height,
          }
        : null;
  assert.equal(assets.length, options.fullFixture ? 16 : options.genericImages ? 1 : 0);
  for (const task of tasks)
    if (task.resource === "product") {
      const p = snapshotSchema.shape.products.element.parse(task.source),
        parent = ids.get(task.key);
      assert.ok(parent);
      for (const [index, variant] of p.variants.entries())
        variants.set(variant.id, {
          id: `gid://shopify/ProductVariant/${1000 + variants.size}`,
          parent,
          index,
        });
    }
  let nextVariantId = 1000 + variants.size;
  const order = new Map<string, string[]>();
  const imageId = (file: string) => {
    const task = tasks.find((task) => task.resource === "image" && task.identity[0] === file);
    assert.ok(task);
    const id = ids.get(task.key);
    assert.ok(id);
    return id;
  };
  const suffix = (id: string) => id.slice(id.lastIndexOf("/") + 1),
    pi = { hasNextPage: false, endCursor: null },
    shop = {
      id: shopId,
      myshopifyDomain: config.domain,
      name: snapshot.shop.name,
      currencyCode: snapshot.shop.currency,
      ianaTimezone: snapshot.shop.timezone,
      plan: { partnerDevelopment: true },
      metafield: { value: "true" },
    },
    seo = (
      value:
        | { title?: string | null | undefined; description?: string | null | undefined }
        | undefined,
    ) => ({
      title: value?.title ?? null,
      description: value?.description ?? null,
    });
  const contentSeo = (value: Parameters<typeof seo>[0]) => ({
    seoTitle: value?.title == null ? null : { value: value.title, type: "single_line_text_field" },
    seoDescription:
      value?.description == null
        ? null
        : { value: value.description, type: "single_line_text_field" },
  });
  let writes = 0,
    reads = 0,
    gets = 0,
    drift = false,
    generatedDrift = false,
    nativeImageDrift = false;
  function getTask(id: string) {
    const task = tasks.find((task) => ids.get(task.key) === id);
    assert.ok(task, `Unknown authored ID ${id}`);
    return task;
  }
  function node(id: string): Record<string, unknown> {
    if (id === locationId) return { __typename: "Location", id, isActive: true };
    if (id === publication.id)
      return {
        __typename: "Publication",
        id,
        catalog: {
          __typename: "AppCatalog",
          id: publication.catalogId,
          apps: { nodes: [{ id: publication.appId }], pageInfo: pi },
        },
      };
    const variant = [...variants.values()].find((variant) => variant.id === id);
    if (variant) {
      const parent = node(variant.parent),
        task = getTask(variant.parent),
        p = snapshotSchema.shape.products.element.parse(task.source);
      return {
        __typename: "ProductVariant",
        id,
        product: { id: parent.id, handle: parent.handle, tags: parent.tags },
        selectedOptions: p.variants[variant.index]?.optionValues,
      };
    }
    const task = getTask(id),
      common = {
        id,
        handle: task.identity.at(-1),
        __typename: task.resource[0]?.toUpperCase() + task.resource.slice(1),
      },
      date = "2026-10-15T00:00:00Z";
    if (task.resource === "image") {
      const image = snapshotSchema.shape.products.element.shape.images.element.parse(task.source);
      return {
        __typename: "MediaImage",
        id,
        alt: image.alt,
        fileStatus: "READY",
        image: { url: imageUrl(image.file), width: image.width, height: image.height },
        originalSource: {
          url: `https://cdn.shopify.com/original/${image.file}`,
          fileSize: bytesFor(image.file).length,
        },
      };
    }
    if (task.resource === "product") {
      const p = snapshotSchema.shape.products.element.parse(task.source);
      return {
        ...common,
        title: drift ? "Changed source" : p.title,
        descriptionHtml: p.descriptionHtml,
        templateSuffix: p.templateSuffix,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        status: "ACTIVE",
        seo: seo(p.seo),
        category: null,
        isGiftCard: false,
        requiresSellingPlan: false,
        createdAt: generatedDrift ? "2026-10-15T00:00:01Z" : date,
        publishedAt: date,
        legacyResourceId: suffix(id),
        options: p.options.map((option, index) => ({
          name: option.name,
          position: index + 1,
          optionValues: option.values.map((name) => ({ name })),
        })),
        media: {
          nodes: p.images.map((image) => ({
            ...node(imageId(image.file)),
            image: adminImage(image),
          })),
          pageInfo: pi,
        },
        variants: {
          nodes: p.variants.map((source, index) => {
            const actual = variants.get(source.id);
            assert.ok(actual);
            return {
              id: actual.id,
              __typename: "ProductVariant",
              legacyResourceId: suffix(actual.id),
              position: index + 1,
              selectedOptions: source.optionValues,
              price: source.price,
              compareAtPrice: source.compareAtPrice,
              sku: source.sku,
              taxable: source.taxable,
              inventoryPolicy: source.inventoryPolicy === "continue" ? "CONTINUE" : "DENY",
              inventoryQuantity: source.inventoryQuantity,
              barcodes: {
                nodes: source.barcode ? [{ value: source.barcode, type: null }] : [],
                pageInfo: pi,
              },
              media: {
                nodes: source.image
                  ? [{ __typename: "MediaImage", id: imageId(source.image) }]
                  : [],
                pageInfo: pi,
              },
              inventoryItem: {
                id: `gid://shopify/InventoryItem/${suffix(actual.id)}`,
                sku: source.sku,
                tracked: true,
                requiresShipping: source.requiresShipping,
                measurement: { weight: { value: source.weight, unit: "GRAMS" } },
                inventoryLevel: {
                  isActive: true,
                  location: { id: locationId },
                  quantities: [{ name: "available", quantity: source.inventoryQuantity }],
                },
              },
            };
          }),
          pageInfo: pi,
        },
      };
    }
    if (task.resource === "collection") {
      const c = snapshotSchema.shape.collections.element.parse(task.source),
        members = (order.get(task.key) ?? c.products).map((handle) => {
          const p = tasks.find(
            (task) => task.resource === "product" && task.identity[0] === handle,
          );
          assert.ok(p);
          return { id: ids.get(p.key), handle };
        });
      return {
        ...common,
        title: c.title,
        descriptionHtml: c.descriptionHtml,
        templateSuffix: c.templateSuffix,
        sortOrder: "MANUAL",
        image: adminImage(c.image),
        seo: seo(c.seo),
        legacyResourceId: suffix(id),
        products: { nodes: members, pageInfo: pi },
        sources: [
          {
            __typename: "CollectionConditionsSource",
            id: "gid://shopify/CollectionConditionsSource/1",
            title: "SOP fixture membership",
            shareable: false,
            targetType: "PRODUCTS",
            app: null,
            inclusion: {
              conditions: [],
              selections: {
                nodes: members.map((product) => ({ product, variantIds: null })),
                pageInfo: pi,
              },
            },
            exclusion: null,
          },
        ],
      };
    }
    if (task.resource === "page") {
      const p = snapshotSchema.shape.pages.element.parse(task.source);
      return {
        ...common,
        title: p.title,
        templateSuffix: p.templateSuffix,
        body: p.bodyHtml,
        isPublished: true,
        ...contentSeo(p.seo),
      };
    }
    if (task.resource === "blog") {
      const b = snapshotSchema.shape.blogs.element.omit({ articles: true }).parse(task.source);
      return {
        ...common,
        title: b.title,
        templateSuffix: b.templateSuffix,
        commentPolicy: b.commentsEnabled ? "MODERATED" : "CLOSED",
        ...contentSeo(b.seo),
      };
    }
    if (task.resource === "article") {
      const a = snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source),
        blogTask = tasks.find(
          (candidate) =>
            candidate.resource === "blog" && candidate.identity[0] === task.identity[0],
        );
      assert.ok(blogTask);
      return {
        ...common,
        title: a.title,
        templateSuffix: a.templateSuffix,
        body: a.bodyHtml,
        summary: a.excerptHtml,
        author: { name: a.author },
        publishedAt: a.publishedAt,
        isPublished: true,
        tags: a.tags,
        blog: { id: ids.get(blogTask.key), handle: task.identity[0] },
        image: adminImage(a.image),
        ...contentSeo(a.seo),
        createdAt: date,
        updatedAt: date,
        commentsCount: { count: a.commentsCount ?? 0, precision: "EXACT" },
      };
    }
    if (task.resource === "menu") {
      const m = snapshotSchema.shape.menus.element.parse(task.source);
      return {
        ...common,
        title: m.title,
        items: m.links.map((link) => ({
          title: link.title,
          type:
            link.type === "http_link"
              ? "HTTP"
              : link.type === "collection_link"
                ? "COLLECTION"
                : "PAGE",
          url: link.type === "http_link" ? link.url : null,
          resourceId: link.resourceHandle
            ? ids.get(tasks.find((task) => task.identity[0] === link.resourceHandle)?.key ?? "")
            : null,
          items: [],
        })),
      };
    }
    throw new Error("Unmodeled authored source");
  }
  const reply = (data: unknown) =>
    Response.json({ data }, { headers: { "x-shopify-api-version": "2026-10" } });
  const fetcher: typeof fetch = async (_url, init) => {
    reads++;
    if (init?.method === "GET") {
      const path = new URL(String(_url)).pathname,
        file = path.split("/").at(-1);
      assert.ok(file && path === `/original/${file}`);
      return new Response(bytesFor(file).slice());
    }
    const body = JSON.parse(String(init?.body)),
      q = String(body.query),
      v = body.variables ?? {};
    if (q.includes("OfflinePreviewShopSettings"))
      return reply({
        shop: {
          ...shop,
          primaryDomain: { host: snapshot.shop.domain },
          description: snapshot.shop.description ?? null,
          currencyFormats: {
            moneyFormat: snapshot.shop.money_format,
            moneyWithCurrencyFormat: snapshot.shop.money_with_currency_format,
          },
        },
      });
    if (q.includes("OfflinePreviewSeedGuard") || q.includes("OfflinePreviewOracleIdentity"))
      return reply({
        shop,
        currentAppInstallation: {
          accessScopes: [
            "write_products",
            "write_inventory",
            "read_locations",
            "write_content",
            "write_online_store_navigation",
            "write_publications",
            "write_metaobjects",
            "write_themes",
            "write_files",
          ].map((handle) => ({ handle })),
        },
      });
    if (q.includes("OfflinePreviewSeedAbsence")) {
      const data: Record<string, unknown> = { shop };
      for (const [kind, root] of [
        ["product", "products"],
        ["collection", "collections"],
        ["page", "pages"],
        ["blog", "blogs"],
        ["article", "articles"],
        ["menu", "menus"],
      ])
        data[root ?? ""] = {
          nodes: tasks
            .filter((task) => task.resource === kind && created.has(ids.get(task.key) ?? ""))
            .map((task) => ({ id: ids.get(task.key), handle: task.identity.at(-1) })),
          pageInfo: pi,
        };
      if (v.blog) data.blog = { id: v.blog, articles: data.articles };
      return reply(data);
    }
    if (q.includes("OfflinePreviewSeedJob")) return reply({ shop, job: { id: v.id, done: true } });
    if (q.includes("OfflinePreviewSeedVariants")) {
      const p = node(v.id);
      return reply({ shop, product: p });
    }
    if (q.includes("OfflinePreviewSeedPublication")) {
      return reply({
        shop,
        nodes: v.ids.map((id: string) => ({
          ...node(id),
          publishedOnPublication: published.has(id),
        })),
      });
    }
    if (
      q.includes("OfflinePreviewSeedIdentities") ||
      q.includes("OfflinePreviewSeedSource") ||
      q.includes("OfflinePreviewSeedGenerated")
    )
      return reply({ shop, nodes: v.ids.map((id: string) => node(id)) });
    assert.ok(q.startsWith("mutation "));
    writes++;
    const operationName = /\{\s*(\w+)\(/.exec(q)?.[1];
    assert.ok(operationName);
    mutations.set(operationName, (mutations.get(operationName) ?? 0) + 1);
    if (q.includes("stagedUploadsCreate"))
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
    if (q.includes("fileCreate")) {
      const task = tasks.find(
        (task) => task.resource === "image" && task.identity[0] === v.files[0].filename,
      );
      assert.ok(task);
      const id = ids.get(task.key);
      assert.ok(id);
      created.add(id);
      return reply({ fileCreate: { files: [{ id }], userErrors: [] } });
    }
    if (q.includes("publishablePublish")) {
      published.add(v.id);
      return reply({ publishablePublish: { publishable: { id: v.id }, userErrors: [] } });
    }
    if (q.includes("collectionReorderProducts")) {
      const task = getTask(v.id),
        current = order.get(task.key);
      assert.ok(current);
      for (const move of v.moves) {
        const product = getTask(move.id),
          handle = product.identity[0];
        assert.ok(handle);
        const from = current.indexOf(handle);
        assert.ok(from >= 0);
        current.splice(from, 1);
        current.splice(Number(move.newPosition), 0, handle);
      }
      return reply({
        collectionReorderProducts: { job: { id: "gid://shopify/Job/1" }, userErrors: [] },
      });
    }
    const operation = [
      "productSet",
      "collectionCreate",
      "collectionUpdate",
      "pageCreate",
      "blogCreate",
      "articleCreate",
      "articleUpdate",
      "menuCreate",
    ].find((operation) => q.includes(`${operation}(`));
    assert.ok(operation, q);
    const kind =
      operation === "productSet" ? "product" : operation.replace(/(?:Create|Update)$/, "");
    const payload = v[kind] ?? v.input ?? v;
    const task = desiredTasks.find(
      (task) => task.resource === kind && task.identity.at(-1) === payload.handle,
    );
    assert.ok(task, operation);
    if (kind === "collection" || kind === "article") {
      const image =
        kind === "collection"
          ? snapshotSchema.shape.collections.element.parse(task.source).image
          : snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source).image;
      assert.deepEqual(
        payload.image,
        image
          ? {
              [kind === "collection" ? "src" : "url"]: imageUrl(image.file),
              altText: image.alt,
            }
          : null,
      );
    }
    const id = ids.get(task.key);
    assert.ok(id);
    if (kind === "product") {
      const product = snapshotSchema.shape.products.element.parse(task.source);
      assert.deepEqual(v.identifier, created.has(id) ? { id } : { handle: product.handle });
      assert.equal(payload.title, product.title);
      assert.equal(payload.descriptionHtml, product.descriptionHtml);
      assert.deepEqual(
        payload.files,
        product.images.map((image) => ({ id: imageId(image.file), alt: image.alt })),
      );
      assert.equal(payload.variants.length, product.variants.length);
      for (const [sourceId, variant] of variants)
        if (variant.parent === id && !product.variants.some((source) => source.id === sourceId))
          variants.delete(sourceId);
      for (const [index, source] of product.variants.entries()) {
        const sent = payload.variants[index],
          previous = variants.get(source.id);
        if (created.has(id) && previous) assert.equal(sent.id, previous.id);
        else assert.equal(sent.id, undefined);
        assert.equal(sent.price, source.price);
        assert.equal(sent.inventoryQuantities[0].quantity, source.inventoryQuantity);
        assert.deepEqual(sent.file, source.image ? { id: imageId(source.image) } : null);
        assert.deepEqual(
          sent.optionValues,
          source.optionValues.map((option) => ({ optionName: option.name, name: option.value })),
        );
        variants.set(source.id, {
          id: previous?.id ?? `gid://shopify/ProductVariant/${nextVariantId++}`,
          parent: id,
          index,
        });
      }
    }
    if (kind === "collection") {
      const collection = snapshotSchema.shape.collections.element.parse(task.source),
        current = [...(order.get(task.key) ?? [])];
      if (created.has(id)) {
        const inclusion = payload.sourcesToUpdate[0].condition.inclusion;
        assert.equal(payload.id, id);
        for (const selection of inclusion.selectionsToRemove) {
          const handle = getTask(selection.productId).identity[0];
          assert.ok(handle && current.includes(handle));
          current.splice(current.indexOf(handle), 1);
        }
        for (const selection of inclusion.selectionsToAdd) {
          const handle = getTask(selection.productId).identity[0];
          assert.ok(handle && !current.includes(handle));
          current.push(handle);
        }
      } else
        for (const selection of payload.sources[0].source.inclusion.selections) {
          const handle = getTask(selection.productId).identity[0];
          assert.ok(handle);
          current.push(handle);
        }
      assert.deepEqual([...current].sort(), [...collection.products].sort());
      order.set(task.key, options.fullFixture ? current.reverse() : current);
    }
    tasks[tasks.findIndex((current) => current.key === task.key)] = task;
    created.add(id);
    return reply({ [operation]: { [kind]: { id }, userErrors: [] } });
  };
  const theme = (id: string) => ({
    id: `gid://shopify/OnlineStoreTheme/${id}`,
    role: "UNPUBLISHED" as const,
    processing: false,
    processingFailed: false,
  });
  const imageDependencies = {
    readIdentity: async () => shop,
    readTheme: async (id: string) => theme(id),
    verifyShopSettings: async () => {},
    readThemeFiles: async (id: string) =>
      prepareNativeImageProbe(id === "8" ? "product" : id === "9" ? "collection" : "article").files,
    fetcher: async (url: Parameters<typeof fetch>[0]) => {
      gets++;
      const target = new URL(String(url)),
        parts = target.pathname.split("/").filter(Boolean),
        kind =
          parts[0] === "products"
            ? "product"
            : parts[0] === "collections"
              ? "collection"
              : "article",
        task = tasks.find(
          (task) => task.resource === kind && task.identity.at(-1) === parts.at(-1),
        );
      assert.ok(task);
      const id = ids.get(task.key);
      assert.ok(id);
      const product =
          kind === "product" ? snapshotSchema.shape.products.element.parse(task.source) : null,
        genericImage =
          kind === "collection"
            ? snapshotSchema.shape.collections.element.parse(task.source).image
            : kind === "article"
              ? snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source).image
              : null,
        probe = prepareNativeImageProbe(kind);
      function nativeImage(image: {
        file: string;
        alt: string | null;
        width: number;
        height: number;
      }) {
        return {
          src: nativeImageDrift
            ? "https://cdn.shopify.com/s/files/1/files/foreign.png?v=1"
            : imageUrl(image.file),
          alt: image.alt,
          width: image.width,
          height: image.height,
          id: null,
          position: null,
          productId: null,
          mediaType: null,
          attached: null,
          variants: null,
        };
      }
      const classic = product
        ? product.images.map((image, index) => {
            const attached = product.variants
              .filter((variant) => variant.image === image.file)
              .map((variant) => {
                const actual = variants.get(variant.id);
                assert.ok(actual);
                return suffix(actual.id);
              });
            return {
              ...nativeImage(image),
              id: `${suffix(id)}00${index + 1}`,
              position: index + 1,
              productId: suffix(id),
              attached: attached.length > 0,
              variants: attached,
              preview: null,
            };
          })
        : genericImage
          ? [{ ...nativeImage(genericImage), id: "7001", preview: null }]
          : [];
      const value: NativeImagePayload = {
        shopId: "1",
        permanentDomain: config.domain,
        kind,
        parentId: suffix(id),
        handle: task.identity.at(-1) ?? "",
        images: classic,
        media: product
          ? product.images.map((image, index) => ({
              ...nativeImage(image),
              id: suffix(imageId(image.file)),
              position: index + 1,
              mediaType: "image",
              preview: nativeImage(image),
            }))
          : [],
        variants: product
          ? product.variants.map((source) => {
              const actual = variants.get(source.id);
              assert.ok(actual);
              const imageIndex = product.images.findIndex((image) => image.file === source.image);
              return {
                id: suffix(actual.id),
                imageId: imageIndex < 0 ? null : (classic[imageIndex]?.id ?? null),
                mediaId: source.image ? suffix(imageId(source.image)) : null,
              };
            })
          : [],
      };
      return new Response(
        `<script id="${probe.key}" type="application/json">${JSON.stringify(Buffer.from(JSON.stringify(value)).toString("base64"))}</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  };
  const captureAdapters = {
    readIdentity: async () => shop,
    readTheme: async (id: string) => theme(id),
    verifyThemeFiles: async () => {},
    verifyShopSettings: async () => {},
    readCaptureContextSource: async () => captureContextSource,
  };
  function cartTransport(
    options: { text?: (epoch: string) => string; sectionId?: string; epoch?: string } = {},
  ) {
    const epoch = options.epoch ?? String(Math.floor(Date.now() / 1000));
    let note: string | null = null,
      items: Record<string, unknown>[] = [],
      posts = 0;
    const cart = () => {
      const total = items.reduce((sum, item) => sum + Number(item.line_price), 0);
      return {
        token: "authored-private-token",
        note,
        attributes: {},
        currency: snapshot.shop.currency,
        item_count: items.reduce((sum, item) => sum + Number(item.quantity), 0),
        items,
        original_total_price: total,
        items_subtotal_price: total,
        total_price: total,
        total_discount: 0,
        cart_level_discount_applications: [],
        discount_codes: [],
      };
    };
    const transport: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      assert.equal(target.hostname, config.domain);
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("X-Shopify-Access-Token"), false);
      if (target.pathname === "/cart.js")
        return new Response(JSON.stringify(cart()), {
          headers: {
            "content-type": "text/javascript",
            "set-cookie": "cart=authored-private; Path=/; Secure",
          },
        });
      if (init?.method === "POST") {
        posts++;
        const payload = JSON.parse(String(init.body));
        if (target.pathname === "/cart/update.js") note = payload.note;
        else {
          assert.equal(target.pathname, "/cart/add.js");
          items = payload.items
            .map((item: { id: string; quantity: number }) => {
              const entry = [...variants.entries()].find(
                ([, variant]) => suffix(variant.id) === item.id,
              );
              assert.ok(entry);
              const p = snapshot.products.find((product) =>
                  product.variants.some((variant) => variant.id === entry[0]),
                ),
                source = p?.variants[0];
              assert.ok(p && source);
              const price = Math.round(Number(source.price) * 100),
                product = tasks.find(
                  (task) => task.resource === "product" && task.identity[0] === p.handle,
                );
              assert.ok(product);
              return {
                id: item.id,
                variant_id: item.id,
                product_id: suffix(ids.get(product.key) ?? ""),
                handle: p.handle,
                key: `${item.id}:authored`,
                quantity: item.quantity,
                price,
                original_price: price,
                final_price: price,
                line_price: price * item.quantity,
                original_line_price: price * item.quantity,
                final_line_price: price * item.quantity,
                total_discount: 0,
                properties: {},
                discounts: [],
                line_level_discount_allocations: [],
              };
            })
            .reverse();
        }
        return Response.json(cart());
      }
      gets++;
      const value = cart(),
        context = {
          shopId: "1",
          domain: config.domain,
          path: target.pathname,
          locale: snapshot.shop.locale,
          epoch,
          cart: {
            currency: value.currency,
            note: value.note,
            taxesIncluded: false,
            dutiesIncluded: false,
            itemCount: value.item_count,
            originalTotal: value.original_total_price,
            subtotal: value.items_subtotal_price,
            total: value.total_price,
            discount: 0,
            items: items.map((item) => ({
              variantId: item.variant_id,
              productId: item.product_id,
              handle: item.handle,
              key: item.key,
              quantity: item.quantity,
              price: item.price,
              originalPrice: item.original_price,
              finalPrice: item.final_price,
              linePrice: item.line_price,
              originalLinePrice: item.original_line_price,
              finalLinePrice: item.final_line_price,
              instructions: null,
              parentRelationship: null,
              itemComponents: null,
            })),
          },
        };
      return new Response(
        `<div id="shopify-section-${options.sectionId ?? "main"}">${options.text?.(epoch) ?? "Authored case"}</div><script id="${captureContextKey}" type="application/json">${JSON.stringify(Buffer.from(JSON.stringify(context)).toString("base64"))}</script>`,
        { headers: { "content-type": "text/html" } },
      );
    };
    return { transport, posts: () => posts };
  }
  return {
    snapshot,
    plan,
    state,
    selectState: (hash: string) => {
      const state = plan.states.find((state) => state.hash === hash);
      assert.ok(state);
      desiredTasks = state.tasks;
    },
    variantIds: () => new Map([...variants].map(([key, value]) => [key, value.id])),
    mutationCounts: () => new Map(mutations),
    assets,
    readImage: async (file: string) => {
      assert.ok(assets.some((asset) => asset.file === file));
      return bytesFor(file).slice();
    },
    fetcher,
    imageDependencies,
    captureAdapters,
    cartTransport,
    shop: {
      readNativeSettings: async () => ({
        domain: config.domain,
        shopId,
        apiVersion: "2026-10",
        locale: snapshot.shop.locale,
        shop: snapshot.shop,
      }),
    },
    counts: () => ({ writes, reads, gets }),
    changeSource: () => {
      drift = true;
    },
    changeGenerated: () => {
      generatedDrift = true;
    },
    changeNativeImage: () => {
      nativeImageDrift = true;
    },
    reset: () => {
      drift = false;
      generatedDrift = false;
      nativeImageDrift = false;
    },
  };
}

/** Small authored fixture; not the locked release data or Shopify evidence. */
export function compactCaseStore(options: { genericImages?: boolean } = {}) {
  return authoredCaseStore(options);
}
/** Unmodified locked fixture, with all store responses still authored HTTP mocks. */
export function fullFixtureStore() {
  return authoredCaseStore({ fullFixture: true });
}
