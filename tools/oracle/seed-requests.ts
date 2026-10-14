import { basename } from "node:path";
import type { MenuLink } from "../../packages/data/src/schema.js";
import { snapshotSchema } from "../../packages/data/src/schema.js";
import { themePath } from "../../packages/theme/src/index.js";
import type { SeedTask } from "./seed-plan.js";

export type SeedValue =
  | string
  | number
  | boolean
  | null
  | SeedValue[]
  | { [key: string]: SeedValue };
export interface SeedRequestTemplate {
  operation: string;
  variableTypes: Record<string, string>;
  variables: Record<string, SeedValue>;
  selection: string;
  calibration: string[];
}
export interface SeedRequestOptions {
  mode: "create" | "update";
  /** Explicitly observed new variants; missing ID bindings never imply creation. */
  newVariantIds?: readonly string[];
  /** Observed membership of this fixture-owned collection, required for update deltas. */
  collectionMembers?: readonly string[];
  imageBytes?: number;
}
/** Shared step selection for the transport and durable request fingerprint. */
export function compileSeedStepTemplates(
  task: SeedTask,
  kind: "task" | "publication" | "collection-order",
  options: SeedRequestOptions,
  observedOrder?: readonly string[],
): SeedRequestTemplate[] {
  if (kind === "task") return compileSeedTask(task, options);
  if (kind === "publication" && (task.resource === "product" || task.resource === "collection"))
    return [
      compileSeedPublication(
        task.resource === "product" ? "Product" : "Collection",
        task.identity[0] ?? "",
      ),
    ];
  if (kind === "collection-order" && task.resource === "collection" && observedOrder) {
    const collection = snapshotSchema.shape.collections.element.parse(task.source);
    if (collection.sortOrder !== "manual") throw new Error("Manual collection required");
    return compileSeedCollectionOrder(task.identity[0] ?? "", observedOrder, collection.products);
  }
  throw new Error("Step unavailable");
}
export const seedBindingKey = (kind: string, ...identity: string[]) =>
  JSON.stringify([kind, ...identity]);
function binding(kind: string, identity: readonly string[], resource = kind): SeedValue {
  return { $seedBinding: seedBindingKey(kind, ...identity), $seedType: resource };
}
function request(
  operation: string,
  variableTypes: Record<string, string>,
  variables: Record<string, SeedValue>,
  result: string,
): SeedRequestTemplate {
  return {
    operation,
    variableTypes,
    variables,
    selection: `${result} { id } userErrors { field message }`,
    calibration: ["remote-user-errors", "resource-ids", "read-back-source-equality"],
  };
}
function untypedMetafields(value: object) {
  if (Object.keys(value).length) throw new Error("Typed metafield definitions required");
}
function seoValue(source: {
  title?: string | null | undefined;
  description?: string | null | undefined;
}): SeedValue {
  return {
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.description === undefined ? {} : { description: source.description }),
  };
}
function imageValue(image: { file: string; alt: string } | null, article = false): SeedValue {
  if (!image) return null;
  return {
    [article ? "url" : "src"]: binding("image-url", [image.file], "URL"),
    altText: image.alt,
  };
}

/** Builds requests only. Resolving dependencies and executing mutations are separate guarded steps. */
export function compileSeedTask(
  task: SeedTask,
  options: SeedRequestOptions,
): SeedRequestTemplate[] {
  if (options.mode !== "create" && options.mode !== "update")
    throw new Error("Explicit seed request mode required");
  const update = options.mode === "update";
  if (task.resource === "image") {
    const source = snapshotSchema.shape.products.element.shape.images.element.parse(task.source);
    themePath(source.file);
    if (update) return []; // Reuse only a previously verified processed-image binding.
    if (!Number.isSafeInteger(options.imageBytes) || !options.imageBytes || options.imageBytes < 0)
      throw new Error("Verified local image byte count required");
    const staged: SeedRequestTemplate = {
      operation: "stagedUploadsCreate",
      variableTypes: { input: "[StagedUploadInput!]!" },
      variables: {
        input: [
          {
            resource: "IMAGE",
            filename: basename(source.file),
            mimeType: "image/png",
            httpMethod: "POST",
            fileSize: String(options.imageBytes),
          },
        ],
      },
      selection:
        "stagedTargets { url resourceUrl parameters { name value } } userErrors { field message }",
      calibration: [
        "staged-upload-target",
        "upload-completed",
        "processed-image-status-and-dimensions",
      ],
    };
    const create = request(
      "fileCreate",
      { files: "[FileCreateInput!]!" },
      {
        files: [
          {
            filename: basename(source.file),
            contentType: "IMAGE",
            alt: source.alt,
            originalSource: binding("staged-image-url", [source.file], "STAGED_URL"),
            duplicateResolutionMode: "RAISE_ERROR",
          },
        ],
      },
      "files",
    );
    create.calibration.push("processed-image-status-and-dimensions");
    return [staged, create];
  }
  if (task.resource === "product") {
    const p = snapshotSchema.shape.products.element.parse(task.source);
    if (task.identity[0] !== p.handle) throw new Error("Seed task identity mismatch");
    untypedMetafields(p.metafields);
    if (
      new Set(p.images.map((i) => i.file)).size !== p.images.length ||
      new Set(p.options.map((o) => o.name)).size !== p.options.length ||
      p.options.some((o) => !o.values.length || new Set(o.values).size !== o.values.length)
    )
      throw new Error("Ambiguous product image or option identity");
    if (p.options.length < 1 || p.options.length > 3 || p.variants.length > 250)
      throw new Error("Product option/variant bound exceeded");
    if (p.sellingPlanGroups?.length || p.requiresSellingPlan || p.quantityPriceBreaksConfigured)
      throw new Error("Selling-plan/quantity-price adapter required");
    if (p.category && !p.category.id) throw new Error("Taxonomy category ID required");
    const newVariants = new Set(options.newVariantIds ?? []);
    if ([...newVariants].some((id) => !p.variants.some((v) => v.id === id)))
      throw new Error("Unknown new variant identity");
    const combinations = new Set<string>();
    const variants = p.variants.map((v, index): SeedValue => {
      const values = p.options.map((o) => {
        const selected = v.optionValues.find((s) => s.name === o.name);
        if (!selected || !o.values.includes(selected.value))
          throw new Error("Invalid variant options");
        return { optionName: o.name, name: selected.value };
      });
      const combination = JSON.stringify(values);
      if (combinations.has(combination)) throw new Error("Duplicate variant options");
      combinations.add(combination);
      if (
        v.inventoryManagement !== "shopify" ||
        v.inventoryQuantity === undefined ||
        v.inventoryPolicy === undefined ||
        v.inventoryQuantity < -2147483648 ||
        v.inventoryQuantity > 2147483647
      )
        throw new Error("Explicit Shopify inventory source required");
      if (v.available !== (v.inventoryQuantity > 0 || v.inventoryPolicy === "continue"))
        throw new Error("Inventory availability conflict");
      if (
        v.requiresSellingPlan ||
        v.sellingPlanAllocations?.length ||
        v.quantityPriceBreaks?.length ||
        (v.unitPrice !== undefined && v.unitPrice !== null) ||
        v.unitPriceMeasurement ||
        v.storeAvailabilities?.length ||
        (v.quantityRule &&
          (v.quantityRule.min !== 1 ||
            v.quantityRule.max !== null ||
            v.quantityRule.increment !== 1))
      )
        throw new Error("Variant supplemental-source adapter required");
      if (v.image !== null && !p.images.some((i) => i.file === v.image))
        throw new Error("Missing variant image");
      return {
        ...(update && !newVariants.has(v.id)
          ? { id: binding("variant-id", [p.handle, v.id], "ProductVariant") }
          : {}),
        optionValues: values,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        sku: v.sku,
        barcodes: v.barcode ? [{ value: v.barcode }] : [],
        position: index + 1,
        file: v.image === null ? null : { id: binding("image-id", [v.image], "MediaImage") },
        inventoryPolicy: v.inventoryPolicy === "deny" ? "DENY" : "CONTINUE",
        inventoryQuantities: [
          {
            name: "available",
            locationId: binding("inventory-location", [], "Location"),
            quantity: v.inventoryQuantity,
          },
        ],
        inventoryItem: {
          tracked: true,
          ...(v.requiresShipping === undefined ? {} : { requiresShipping: v.requiresShipping }),
          ...(v.weight === undefined
            ? {}
            : { measurement: { weight: { value: v.weight, unit: "GRAMS" } } }),
        },
        ...(v.taxable === undefined ? {} : { taxable: v.taxable }),
      };
    });
    const input: Record<string, SeedValue> = {
      handle: p.handle,
      title: p.title,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      tags: p.tags,
      templateSuffix: p.templateSuffix,
      status: "ACTIVE",
      productOptions: p.options.map((o, index) => ({
        name: o.name,
        position: index + 1,
        values: o.values.map((name) => ({ name })),
      })),
      files: p.images.map((i) => ({ id: binding("image-id", [i.file], "MediaImage"), alt: i.alt })),
      variants,
      ...(p.seo
        ? {
            seo: {
              ...(p.seo.title === undefined ? {} : { title: p.seo.title }),
              ...(p.seo.description === undefined ? {} : { description: p.seo.description }),
            },
          }
        : {}),
      ...(p.category === undefined ? {} : { category: p.category?.id ?? null }),
      ...(p.giftCard === undefined ? {} : { giftCard: p.giftCard }),
      ...(p.requiresSellingPlan === undefined
        ? {}
        : { requiresSellingPlan: p.requiresSellingPlan }),
    };
    const r = request(
      "productSet",
      { input: "ProductSetInput!", synchronous: "Boolean!", identifier: "ProductSetIdentifiers!" },
      {
        input,
        synchronous: true,
        identifier: update
          ? { id: binding("product-id", [p.handle], "Product") }
          : { handle: p.handle },
      },
      "product",
    );
    r.calibration.push(
      "variant-ids-by-options",
      "generated-product-timestamps",
      "variant-read-only-metadata",
    );
    return [r];
  }
  if (task.resource === "collection") {
    const c = snapshotSchema.shape.collections.element.parse(task.source);
    if (
      task.identity[0] !== c.handle ||
      new Set(c.products).size !== c.products.length ||
      c.products.length > 250
    )
      throw new Error("Invalid collection identity/membership");
    const sorts: Record<string, string> = {
      manual: "MANUAL",
      "best-selling": "BEST_SELLING",
      "title-ascending": "ALPHA_ASC",
      "title-descending": "ALPHA_DESC",
      "price-ascending": "PRICE_ASC",
      "price-descending": "PRICE_DESC",
      "created-ascending": "CREATED",
      "created-descending": "CREATED_DESC",
    };
    const sort = sorts[c.sortOrder];
    if (!sort) throw new Error("Unsupported collection sort order");
    const select = (handles: readonly string[]): SeedValue[] =>
      handles.map((h) => ({ productId: binding("product-id", [h], "Product") }));
    const input: Record<string, SeedValue> = {
      handle: c.handle,
      title: c.title,
      descriptionHtml: c.descriptionHtml,
      templateSuffix: c.templateSuffix,
      sortOrder: sort,
      image: imageValue(c.image),
      ...(c.seo ? { seo: seoValue(c.seo) } : {}),
    };
    if (update) {
      if (
        !options.collectionMembers ||
        new Set(options.collectionMembers).size !== options.collectionMembers.length
      )
        throw new Error("Observed collection membership required");
      const before = new Set(options.collectionMembers),
        desired = new Set(c.products);
      input.id = binding("collection-id", [c.handle], "Collection");
      input.sourcesToUpdate = [
        {
          condition: {
            id: binding("collection-source-id", [c.handle], "CollectionConditionsSource"),
            inclusion: {
              selectionsToAdd: select(c.products.filter((h) => !before.has(h))),
              selectionsToRemove: select(options.collectionMembers.filter((h) => !desired.has(h))),
            },
          },
        },
      ];
    } else
      input.sources = [
        {
          source: {
            title: "SOP fixture membership",
            targetType: "PRODUCTS",
            position: 0,
            inclusion: { selections: select(c.products) },
          },
        },
      ];
    const r = request(
      update ? "collectionUpdate" : "collectionCreate",
      { collection: update ? "CollectionUpdateInput!" : "CollectionCreateInput!" },
      { collection: input },
      "collection",
    );
    r.calibration.push("owned-collection-source", "ordered-collection-membership");
    return [r];
  }
  if (task.resource === "page") {
    const p = snapshotSchema.shape.pages.element.parse(task.source);
    if (task.identity[0] !== p.handle) throw new Error("Seed task identity mismatch");
    untypedMetafields(p.metafields);
    return [
      request(
        update ? "pageUpdate" : "pageCreate",
        {
          ...(update ? { id: "ID!" } : {}),
          page: update ? "PageUpdateInput!" : "PageCreateInput!",
        },
        {
          ...(update ? { id: binding("page-id", [p.handle], "Page") } : {}),
          page: {
            handle: p.handle,
            title: p.title,
            body: p.bodyHtml,
            templateSuffix: p.templateSuffix,
            isPublished: true,
            ...(p.seo ? { seo: seoValue(p.seo) } : {}),
          },
        },
        "page",
      ),
    ];
  }
  if (task.resource === "blog") {
    const p = snapshotSchema.shape.blogs.element.omit({ articles: true }).parse(task.source);
    if (task.identity[0] !== p.handle) throw new Error("Seed task identity mismatch");
    untypedMetafields(p.metafields);
    return [
      request(
        update ? "blogUpdate" : "blogCreate",
        {
          ...(update ? { id: "ID!" } : {}),
          blog: update ? "BlogUpdateInput!" : "BlogCreateInput!",
        },
        {
          ...(update ? { id: binding("blog-id", [p.handle], "Blog") } : {}),
          blog: {
            handle: p.handle,
            title: p.title,
            templateSuffix: p.templateSuffix,
            ...(p.commentsEnabled === undefined
              ? {}
              : { commentPolicy: p.commentsEnabled ? "MODERATED" : "CLOSED" }),
            ...(p.seo ? { seo: seoValue(p.seo) } : {}),
          },
        },
        "blog",
      ),
    ];
  }
  if (task.resource === "article") {
    const a = snapshotSchema.shape.blogs.element.shape.articles.element.parse(task.source);
    const blog = task.identity[0];
    if (!blog || task.identity[1] !== a.handle) throw new Error("Seed article identity mismatch");
    untypedMetafields(a.metafields);
    const r = request(
      update ? "articleUpdate" : "articleCreate",
      {
        ...(update ? { id: "ID!" } : {}),
        article: update ? "ArticleUpdateInput!" : "ArticleCreateInput!",
      },
      {
        ...(update ? { id: binding("article-id", [blog, a.handle], "Article") } : {}),
        article: {
          blogId: binding("blog-id", [blog], "Blog"),
          handle: a.handle,
          title: a.title,
          body: a.bodyHtml,
          summary: a.excerptHtml,
          author: { name: a.author },
          publishDate: a.publishedAt,
          isPublished: true,
          tags: a.tags,
          templateSuffix: a.templateSuffix,
          image: imageValue(a.image, true),
          ...(a.seo ? { seo: seoValue(a.seo) } : {}),
        },
      },
      "article",
    );
    r.calibration.push("generated-article-timestamps-and-comments");
    return [r];
  }
  if (task.resource === "menu") {
    const m = snapshotSchema.shape.menus.element.parse(task.source);
    if (task.identity[0] !== m.handle) throw new Error("Seed menu identity mismatch");
    const resources: Record<string, [string, string]> = {
      product_link: ["PRODUCT", "Product"],
      collection_link: ["COLLECTION", "Collection"],
      page_link: ["PAGE", "Page"],
      blog_link: ["BLOG", "Blog"],
    };
    function items(links: MenuLink[], depth: number): SeedValue[] {
      if (links.length && depth > 3) throw new Error("Menu depth exceeded");
      return links.map((link) => {
        const target = resources[link.type];
        if (link.type !== "http_link" && (!target || !link.resourceHandle))
          throw new Error("Unsupported menu reference");
        return {
          title: link.title,
          type: target?.[0] ?? "HTTP",
          ...(target
            ? {
                resourceId: binding(
                  `${target[1].toLowerCase()}-id`,
                  [link.resourceHandle ?? ""],
                  target[1],
                ),
              }
            : { url: link.url }),
          items: items(link.links, depth + 1),
        };
      });
    }
    return [
      request(
        update ? "menuUpdate" : "menuCreate",
        {
          ...(update ? { id: "ID!" } : {}),
          title: "String!",
          handle: "String!",
          items: update ? "[MenuItemUpdateInput!]!" : "[MenuItemCreateInput!]!",
        },
        {
          ...(update ? { id: binding("menu-id", [m.handle], "Menu") } : {}),
          title: m.title,
          handle: m.handle,
          items: items(m.links, 1),
        },
        "menu",
      ),
    ];
  }
  throw new Error("Metaobject definition adapter required");
}

export function compileSeedPublication(
  resource: "Product" | "Collection",
  handle: string,
): SeedRequestTemplate {
  const output = request(
    "publishablePublish",
    { id: "ID!", input: "[PublicationInput!]!" },
    {
      id: binding(`${resource.toLowerCase()}-id`, [handle], resource),
      input: [{ publicationId: binding("online-store-publication", [], "Publication") }],
    },
    "publishable",
  );
  output.selection = "userErrors { field message }";
  output.calibration.push("verified-online-store-publication");
  return output;
}

/** Compute only moved products, applying every move against the evolving observed order. */
export function compileSeedCollectionOrder(
  handle: string,
  observed: readonly string[],
  desired: readonly string[],
): SeedRequestTemplate[] {
  if (
    observed.length !== desired.length ||
    observed.length > 250 ||
    new Set(observed).size !== observed.length ||
    new Set(desired).size !== desired.length ||
    desired.some((h) => !observed.includes(h))
  )
    throw new Error("Verified equal collection membership required before ordering");
  const current = [...observed],
    moves: SeedValue[] = [];
  for (let i = 0; i < desired.length; i++) {
    const handle = desired[i];
    if (handle === undefined || current[i] === handle) continue;
    const from = current.indexOf(handle);
    current.splice(from, 1);
    current.splice(i, 0, handle);
    moves.push({ id: binding("product-id", [handle], "Product"), newPosition: String(i) });
  }
  if (!moves.length) return [];
  const result = request(
    "collectionReorderProducts",
    { id: "ID!", moves: "[MoveInput!]!" },
    { id: binding("collection-id", [handle], "Collection"), moves },
    "job",
  );
  result.calibration.push("reorder-job-completed", "ordered-collection-membership");
  return [result];
}

/** A template is not a request until every required binding resolves to a real dependency. */
export function resolveSeedRequest(
  template: SeedRequestTemplate,
  values: Readonly<Record<string, string>>,
) {
  function resolve(value: SeedValue): SeedValue {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(resolve);
    if (typeof value.$seedBinding === "string" && typeof value.$seedType === "string") {
      if (Object.keys(value).length !== 2 || !Object.hasOwn(values, value.$seedBinding))
        throw new Error("Missing seed binding");
      const actual = values[value.$seedBinding];
      if (!actual) throw new Error("Empty seed binding");
      if (value.$seedType === "URL" || value.$seedType === "STAGED_URL") {
        let url: URL;
        try {
          url = new URL(actual);
        } catch {
          throw new Error("Invalid Shopify image URL binding");
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          url.hash ||
          !(value.$seedType === "STAGED_URL"
            ? [
                "shopify-staged-uploads.storage.googleapis.com",
                "shopify.s3.amazonaws.com",
              ].includes(url.hostname)
            : ["cdn.shopify.com", "shopify-shop-assets.storage.googleapis.com"].includes(
                url.hostname,
              ))
        )
          throw new Error("Invalid Shopify image URL binding");
      } else if (
        !/^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/[1-9]\d*$/.test(actual) ||
        (value.$seedType !== "ID" && !actual.startsWith(`gid://shopify/${value.$seedType}/`))
      )
        throw new Error("Invalid seed ID binding");
      return actual;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  }
  const query = `mutation OfflinePreviewSeed(${Object.entries(template.variableTypes)
    .map(([name, type]) => `$${name}: ${type}`)
    .join(", ")}) { ${template.operation}(${Object.keys(template.variables)
    .map((name) => `${name}: $${name}`)
    .join(", ")}) { ${template.selection} } }`;
  return {
    query,
    variables: Object.fromEntries(
      Object.entries(template.variables).map(([key, value]) => [key, resolve(value)]),
    ),
  };
}
