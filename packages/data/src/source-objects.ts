import { Drop } from "liquidjs";
import { ImageDirectory, MissingImage, NamedImageDrop } from "./images.js";
import { Deferred, lazyList, materializeList } from "./lazy-list.js";
import {
  availableFields,
  commonLiquidObjects,
  type LiquidRecord,
  liquidCart,
  liquidCartPresentation,
  liquidMenu,
  liquidProduct,
  liquidResourceHelpers,
  liquidSearch,
  markCollectionProductList,
  memberValues,
  type ObjectHooks,
  type ObjectTracker,
  type RouteContext,
} from "./objects.js";
import {
  type RenderDescriptor,
  type RenderListQuery,
  type RenderResource,
  type RenderResourceKind,
  RenderSourceError,
  type RenderSourceHeader,
} from "./render-source.js";
import type { Snapshot } from "./schema.js";
import { resourcePath, type SourceSession } from "./source-session.js";
import { storefrontQuery } from "./storefront-filters.js";

export class SourceImageDirectory extends ImageDirectory {
  constructor(
    private readonly session: SourceSession,
    private readonly objectHooks: ObjectHooks,
  ) {
    super([], {
      read: objectHooks.read,
      missing: (property) => objectHooks.missing?.(`image.${property} is absent`),
      unsupported: (property) => objectHooks.unsupported("image", property),
    });
  }
  override liquidMethodMissing(
    filename: string | number,
  ): NamedImageDrop | MissingImage | Promise<NamedImageDrop | MissingImage> {
    return this.session.asset(String(filename)).then((result) => {
      if (result.state !== "present") return new MissingImage();
      return new NamedImageDrop(result.image, `images[${JSON.stringify(filename)}]`, {
        read: this.objectHooks.read,
        missing: (property) => this.objectHooks.missing?.(`image.${property} is absent`),
        unsupported: (property) => this.objectHooks.unsupported("image", property),
      });
    });
  }
}
/** A dictionary is a Drop so Liquid can await handle lookup without enumerating its catalog. */
export class SourceDictionary extends Drop {
  constructor(
    private readonly lookup: (key: string) => Promise<unknown>,
    readonly enumerate: () => Promise<unknown[] | undefined>,
    readonly count: number,
  ) {
    super();
  }
  liquidMethodMissing(key: string): Promise<unknown> {
    return this.lookup(key);
  }
  private list: unknown[] | undefined;
  valueOf(): unknown {
    this.list ??= lazyList(this.count, async (start, length, direction) => {
      const values = await this.enumerate();
      if (!values) return [];
      const offset = direction === 1 ? start : start - length + 1;
      const result = await materializeList(values.slice(offset, offset + length));
      return direction === 1 ? result : result.reverse();
    });
    return this.list;
  }
}
export class SourceObjects {
  readonly globals: LiquidRecord;
  private readonly objects = new Map<string, LiquidRecord>();
  private readonly descriptorByObject = new WeakMap<object, RenderDescriptor>();
  private readonly helpers: ReturnType<typeof liquidResourceHelpers>;
  constructor(
    readonly session: SourceSession,
    readonly header: RenderSourceHeader,
    readonly route: RouteContext,
    readonly hooks: ObjectHooks,
    readonly tracked: ObjectTracker,
  ) {
    this.helpers = liquidResourceHelpers(header, hooks, tracked);
    this.globals = commonLiquidObjects(header, route, hooks, tracked, header.counts);
    const shop = this.globals.shop;
    if (shop && typeof shop === "object") {
      for (const [property, kind] of [
        ["products_count", "product"],
        ["collections_count", "collection"],
      ] as const) {
        if (header.coverage[kind] === "complete") continue;
        Object.defineProperty(shop, property, {
          enumerable: true,
          get: () => {
            hooks.missing?.(
              `Object property shop.${property} is unknown because ${kind} coverage is ${header.coverage[kind]}.`,
            );
            return undefined;
          },
        });
      }
    }
    const dictionaries = {
      all_products: "product",
      collections: "collection",
      pages: "page",
      blogs: "blog",
      linklists: "menu",
    } as const;
    for (const [name, kind] of Object.entries(dictionaries)) {
      const relation =
        kind === "menu" ? "menus" : (`${kind}s` as "products" | "collections" | "pages" | "blogs");
      this.globals[name] = new SourceDictionary(
        async (key) => {
          const found = await this.lookup(kind, key);
          if (found !== null) return found;
          if (kind === "collection") {
            if (key === "all") return this.automaticCollection();
            if (key === "size") return header.counts.collections;
            if (key === "first" || key === "last") {
              const list = await this.list({ relation });
              return list
                ? ((await list[key === "first" ? 0 : list.length - 1]) ?? null)
                : undefined;
            }
          }
          return null;
        },
        () => this.list({ relation }),
        header.counts[relation],
      );
    }
    this.globals.images = new SourceImageDirectory(session, hooks);
    this.globals.metaobjects = new SourceDictionary(
      async (type) =>
        new SourceDictionary(
          async (handle) => {
            if (handle === "values") return this.list({ relation: "metaobjects", type });
            if (handle === "values_count")
              return (await this.list({ relation: "metaobjects", type }))?.length;
            return this.lookup("metaobject", JSON.stringify([type, handle]));
          },
          () => this.list({ relation: "metaobjects", type }),
          0,
        ),
      () => this.list({ relation: "metaobjects" }),
      header.counts.metaobjects,
    );
    this.globals.cart = liquidCartPresentation(
      header,
      tracked,
      new Deferred(async () => (await this.cart()).items as LiquidRecord[]),
    );
    let search: Promise<LiquidRecord> | undefined;
    const query = async (key: string) => {
      search ??= this.search();
      return (await search)[key];
    };
    this.globals.search = tracked(
      {
        id: null,
        url: null,
        terms: route.q,
        performed: new URL(route.path, "https://offline.invalid").searchParams.has("q"),
        get results() {
          return query("results");
        },
        get results_count() {
          return query("results_count");
        },
        get filters() {
          return query("filters");
        },
        default_sort_by: "relevance",
        sort_by: route.sortBy ?? "relevance",
        sort_options: [
          { name: "Relevance", value: "relevance" },
          { name: "Price, low to high", value: "price-ascending" },
          { name: "Price, high to low", value: "price-descending" },
        ].map((value) => tracked(value, "sort_option")),
      },
      "search",
      "search",
    );
  }
  async select(): Promise<void> {
    const { pageType, resourceHandle, blogHandle } = this.route;
    if (resourceHandle && ["product", "collection", "page", "blog", "article"].includes(pageType)) {
      this.globals[pageType] =
        pageType === "collection" && resourceHandle === "all"
          ? ((await this.lookup("collection", "all")) ?? this.automaticCollection())
          : await this.lookup(
              pageType as RenderResourceKind,
              pageType === "article"
                ? JSON.stringify([blogHandle, resourceHandle])
                : resourceHandle,
            );
      if (pageType === "article" && blogHandle)
        this.globals.blog = await this.lookup("blog", blogHandle);
    }
    this.globals.closest = this.tracked(
      {
        product: this.globals.product ?? null,
        collection: this.globals.collection ?? null,
        article: this.globals.article ?? null,
        page: this.globals.page ?? null,
      },
      "closest",
    );
  }
  async lookup(kind: RenderResourceKind, key: string): Promise<LiquidRecord | null | undefined> {
    const descriptor = await this.session.resolve(kind, key);
    if (descriptor === undefined) {
      this.hooks.missing?.(`${kind} source metadata is not captured or incomplete.`);
      return undefined;
    }
    if (descriptor === null) return null;
    const resource = (await this.session.read([descriptor]))[0];
    if (!resource)
      throw new RenderSourceError("PREVIEW_SOURCE_INVALID", "Resolved resource is absent");
    return this.hydrate(descriptor, resource);
  }
  list(
    query: Omit<RenderListQuery, "offset" | "limit">,
    reportDiagnostics = true,
  ): Promise<unknown[] | undefined> {
    return this.session.list(
      query,
      (descriptor, resource) => this.hydrate(descriptor, resource),
      (message) => this.hooks.missing?.(message),
      reportDiagnostics,
    );
  }
  private hydrate(descriptor: RenderDescriptor, resource: RenderResource): LiquidRecord {
    const cached = this.objects.get(descriptor.id);
    if (cached) return cached;
    const path = resourcePath(descriptor),
      { time, image, metafields, metafield, typedMetafield } = this.helpers;
    const id = (value: string | null | undefined) =>
      value === undefined || value === null
        ? value
        : /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
          ? Number(value)
          : value;
    let result: LiquidRecord;
    switch (resource.kind) {
      case "product":
        result = liquidProduct(
          resource.value,
          descriptor.position,
          this.header,
          this.route,
          this.hooks,
          this.tracked,
        );
        Object.defineProperty(result, "collections", {
          enumerable: true,
          get: () => this.list({ relation: "product-collections", owner: descriptor }),
        });
        break;
      case "collection":
        result = this.collection(resource.value, descriptor);
        break;
      case "page":
        result = this.tracked(
          {
            ...availableFields({ id: id(resource.value.id) }),
            handle: resource.value.handle,
            title: resource.value.title,
            content: resource.value.bodyHtml,
            url: `/pages/${resource.value.handle}`,
            template_suffix: resource.value.templateSuffix,
            ...availableFields({
              metafields: metafields(resource.value.metafields, `${path}.metafields`),
            }),
          },
          "page",
          path,
        );
        break;
      case "article": {
        const article = resource.value;
        result = this.tracked(
          {
            ...availableFields({
              id: id(article.id),
              comments_count: article.commentsCount,
              created_at: time(article.createdAt),
              updated_at: time(article.updatedAt),
              comments: article.commentsCount === 0 ? [] : undefined,
            }),
            handle: article.handle,
            title: article.title,
            content: article.bodyHtml,
            excerpt: article.excerptHtml,
            author: article.author,
            ...availableFields({
              published_at: time(article.publishedAt),
              image: article.image
                ? this.tracked(
                    {
                      ...image(article.image, `${path}.image`),
                      ...availableFields({ id: id(article.image.id) }),
                    },
                    "image",
                    `${path}.image`,
                  )
                : article.image,
            }),
            url: `/blogs/${descriptor.blog?.handle}/${article.handle}`,
            tags: article.tags,
            template_suffix: article.templateSuffix,
            ...availableFields({
              metafields: metafields(article.metafields, `${path}.metafields`),
            }),
          },
          "article",
          path,
        );
        break;
      }
      case "blog": {
        const blog = resource.value;
        const articles = () => this.list({ relation: "blog-articles", owner: descriptor });
        const count = () =>
          this.list({ relation: "blog-articles", owner: descriptor }, false).then(
            (list) => list?.length,
          );
        result = this.tracked(
          {
            ...availableFields({ id: id(blog.id) }),
            handle: blog.handle,
            title: blog.title,
            url: `/blogs/${blog.handle}`,
            template_suffix: blog.templateSuffix,
            get articles() {
              return articles();
            },
            get articles_count() {
              return count();
            },
            ...availableFields({
              metafields: metafields(blog.metafields, `${path}.metafields`),
              "comments_enabled?": blog.commentsEnabled,
              "moderated?": blog.commentsModerated,
            }),
          },
          "blog",
          path,
        );
        break;
      }
      case "menu":
        result = liquidMenu(
          resource.value,
          descriptor.position,
          this.header,
          this.route,
          this.tracked,
          async (link) => {
            const url = new URL(link.url, `https://${this.header.shop.domain}`);
            if (url.host !== this.header.shop.domain && url.host !== "offline.invalid") return null;
            const [, namespace, handle = "", child] = url.pathname
              .split("/")
              .map(decodeURIComponent);
            if (link.type === "metaobject_link") {
              this.hooks.unsupportedOperation?.(
                "Metaobject pages for menu links are not available offline.",
              );
              return null;
            }
            if (link.type === "policy_link") {
              const shop = this.globals.shop,
                policies =
                  shop && typeof shop === "object" ? Reflect.get(shop, "policies") : undefined;
              return Array.isArray(policies)
                ? (policies.find((policy) => policy.url === url.pathname) ?? null)
                : null;
            }
            const kinds: Record<string, { namespace: string; kind: RenderResourceKind }> = {
              product_link: { namespace: "products", kind: "product" },
              collection_link: { namespace: "collections", kind: "collection" },
              page_link: { namespace: "pages", kind: "page" },
              blog_link: { namespace: "blogs", kind: "blog" },
              article_link: { namespace: "blogs", kind: "article" },
            };
            const target = kinds[link.type];
            if (!target) return null;
            const value =
              target.namespace === namespace
                ? await this.lookup(
                    target.kind,
                    target.kind === "article" ? JSON.stringify([handle, child]) : handle,
                  )
                : null;
            if (value === null && link.resourceHandle === undefined) {
              this.helpers.absent("link", "resourceHandle");
              return undefined;
            }
            if (value === null)
              this.hooks.missing?.(
                `Menu link ${link.title} references a resource absent from the snapshot.`,
              );
            return value;
          },
        );
        break;
      case "metaobject":
        result = this.tracked(
          {
            ...Object.fromEntries(
              Object.entries(resource.value.fields).map(([key, value]) => [
                key,
                typedMetafield(value)
                  ? metafield(value.type, value.value, `${path}.fields.${key}`)
                  : metafield(undefined, value, `${path}.fields.${key}`),
              ]),
            ),
            system: this.tracked(
              { type: resource.value.type, handle: resource.value.handle },
              "metaobject_system",
              path,
            ),
          },
          "metaobject",
          path,
          Object.fromEntries(
            Object.keys(resource.value.fields).map((key) => [key, `fields.${key}`]),
          ),
        );
        break;
    }
    this.objects.set(descriptor.id, result);
    this.descriptorByObject.set(result, descriptor);
    return result;
  }
  metadata():
    | { source: { title: string; seo?: Snapshot["shop"]["seo"] }; path: string }
    | undefined {
    const value = this.globals[this.route.pageType];
    if (!value || typeof value !== "object") return undefined;
    const descriptor = this.descriptorByObject.get(value),
      resource = descriptor ? this.session.values.get(descriptor.id) : undefined;
    if (!descriptor || !resource || !("title" in resource.value)) return undefined;
    return { source: resource.value, path: resourcePath(descriptor) };
  }
  async settingsList(
    kind: "product" | "collection",
    handles: readonly unknown[],
    missing: () => void,
  ): Promise<unknown[] | undefined> {
    const resolved = await Promise.all(
      handles.map((handle) =>
        typeof handle === "string" ? this.session.resolve(kind, handle) : null,
      ),
    );
    for (const descriptor of resolved) if (descriptor == null) missing();
    if (resolved.includes(undefined)) return undefined;
    const descriptors = resolved.filter(
      (descriptor): descriptor is RenderDescriptor => descriptor != null,
    );
    const list = lazyList(descriptors.length, async (start, length, direction) => {
      const offset = direction === 1 ? start : start - length + 1;
      const selected = descriptors.slice(offset, offset + length),
        resources = await this.session.read(selected);
      const values = selected.map((descriptor, index) =>
        this.hydrate(descriptor, resources[index] as RenderResource),
      );
      return direction === 1 ? values : values.reverse();
    });
    Object.defineProperty(list, "count", { get: () => list.length });
    return list;
  }
  private automatic: LiquidRecord | undefined;
  private automaticCollection(): LiquidRecord {
    this.automatic ??= this.collection({
      handle: "all",
      title: "Products",
      descriptionHtml: "",
      image: null,
      templateSuffix: null,
      sortOrder: "title-ascending",
    });
    return this.automatic;
  }
  private collection(
    source: Extract<RenderResource, { kind: "collection" }>["value"],
    descriptor?: RenderDescriptor,
  ): LiquidRecord {
    const path = descriptor ? resourcePath(descriptor) : "collections.all";
    const { image, collectionSortOptions } = this.helpers;
    const unknown = (property: string) => {
      this.helpers.absent("collection", `${property} (${path})`);
      return undefined;
    };
    const members = () =>
      this.list(
        descriptor
          ? { relation: "collection-products", owner: descriptor }
          : { relation: "all-collection-products" },
      );
    const viewed =
      this.route.pageType === "collection" && this.route.resourceHandle === source.handle;
    const parameters = new URL(this.route.path, "https://offline.invalid").searchParams;
    const transform =
      viewed &&
      ((this.route.sortBy !== null && this.route.sortBy !== source.sortOrder) ||
        [...parameters.keys()].some((key) => key.startsWith("filter.")));
    let query: Promise<ReturnType<typeof storefrontQuery> | undefined> | undefined;
    const evaluate = () =>
      (query ??= (async () => {
        const list = await members();
        if (!list) return unknown("products");
        if (
          viewed &&
          list.length > 0 &&
          this.header.filters === undefined &&
          [...parameters.keys()].some((key) => key.startsWith("filter."))
        )
          return unknown("products (filters or variant.available)");
        const values = await materializeList(list);
        if (values.some((value) => value === null))
          return unknown("products (missing members cannot be filtered or reordered)");
        return storefrontQuery(
          this.header,
          this.route.path,
          values.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const descriptor = this.descriptorByObject.get(value),
              resource = descriptor ? this.session.values.get(descriptor.id) : undefined;
            return resource?.kind === "product"
              ? [{ source: resource.value, value: value as LiquidRecord }]
              : [];
          }),
          {
            apply: viewed,
            lazyFacets: true,
            sortBy: this.route.sortBy,
            defaultSortBy: source.sortOrder,
            track: this.tracked,
            unsupported: (message) => this.hooks.unsupportedOperation?.(message),
            missing: (message) => this.hooks.missing?.(message),
          },
        );
      })());
    const products = async () => {
      const list = transform ? (await evaluate())?.products : await members();
      if (!descriptor && this.header.shop.locale === undefined && list && list.length > 1)
        this.helpers.absent(
          "shop",
          "locale (collections.all product order; snapshot order retained)",
        );
      return list ? markCollectionProductList(list) : list;
    };
    const values = async (key: "tags" | "type" | "vendor") => {
      const list = await members();
      if (!list) return unknown(`all_${key}`);
      const result = await materializeList(list);
      if (result.some((value) => value === null)) return unknown(`all_${key}`);
      return memberValues(result as LiquidRecord[], key);
    };
    const collectionImage = source.image
      ? this.tracked(
          {
            ...image(source.image, `${path}.image`),
            ...availableFields({
              id:
                source.image.id === undefined
                  ? undefined
                  : source.image.id === null
                    ? null
                    : /^\d+$/.test(source.image.id) && Number.isSafeInteger(Number(source.image.id))
                      ? Number(source.image.id)
                      : source.image.id,
            }),
          },
          "image",
          `${path}.image`,
        )
      : source.image;
    const self = this;
    return this.tracked(
      {
        ...availableFields({
          id: !descriptor
            ? null
            : source.id === undefined
              ? undefined
              : /^\d+$/.test(source.id) && Number.isSafeInteger(Number(source.id))
                ? Number(source.id)
                : source.id,
        }),
        handle: source.handle,
        get title() {
          if (!descriptor && self.header.shop.locale === undefined) {
            self.helpers.absent("shop", "locale (collections.all.title)");
            return undefined;
          }
          return source.title;
        },
        description: source.descriptionHtml,
        url: `/collections/${source.handle}`,
        get products() {
          return products();
        },
        get products_count() {
          return products().then((list) => list?.length);
        },
        get all_products_count() {
          return members().then((list) => list?.length);
        },
        get all_tags() {
          return values("tags");
        },
        get all_types() {
          return values("type");
        },
        get all_vendors() {
          return values("vendor");
        },
        ...availableFields({ image: collectionImage }),
        get featured_image() {
          return (async () => {
            if (collectionImage === undefined) return unknown("image");
            if (collectionImage) return collectionImage;
            const list = await members();
            if (!list) return unknown("products");
            const first = await list[0];
            if (first === null) return unknown("featured_image (missing first product)");
            return first && typeof first === "object" ? Reflect.get(first, "featured_image") : null;
          })();
        },
        template_suffix: source.templateSuffix,
        default_sort_by: source.sortOrder,
        get sort_options() {
          return collectionSortOptions(source.sortOptions, path);
        },
        results_count: null,
        terms: null,
        current_vendor: null,
        current_type: null,
        sort_by: this.route.sortBy,
        get filters() {
          return (async () => {
            const list = await members();
            if (!list) return unknown("products (filters)");
            if (list.length === 0) return [];
            if (self.header.filters === undefined) return unknown("filters");
            return (await evaluate())?.filters;
          })();
        },
      },
      "collection",
      path,
    );
  }
  private async cart(): Promise<LiquidRecord> {
    const products = new Map<string, LiquidRecord>(),
      sources = new Map<string, { source: Snapshot["products"][number]; position: number }>();
    for (const handle of new Set(this.header.cart.lines.map((line) => line.productHandle))) {
      const value = await this.lookup("product", handle);
      const descriptor = value ? this.descriptorByObject.get(value) : undefined;
      const source = descriptor ? this.session.values.get(descriptor.id) : undefined;
      if (!value || !descriptor || source?.kind !== "product")
        throw new RenderSourceError("PREVIEW_SOURCE_INVALID", "Cart product is absent");
      products.set(handle, value);
      sources.set(handle, { source: source.value, position: descriptor.position });
    }
    return liquidCart(this.header, products, sources, this.hooks, this.tracked);
  }
  private async search(): Promise<LiquidRecord> {
    const products = new Map<string, LiquidRecord>(),
      pages = new Map<string, LiquidRecord>(),
      articles = new Map<string, Map<string, LiquidRecord>>();
    const catalog: Pick<Snapshot, "products" | "pages" | "blogs"> = {
      products: [],
      pages: [],
      blogs: [],
    };
    for (const relation of ["products", "pages", "blogs"] as const) {
      const list = await this.list({ relation });
      if (!list)
        throw new RenderSourceError(
          "PREVIEW_SOURCE_INCOMPLETE",
          `Search ${relation} was not captured`,
        );
      for (const value of await materializeList(list)) {
        if (!value || typeof value !== "object") continue;
        const descriptor = this.descriptorByObject.get(value),
          source = descriptor ? this.session.values.get(descriptor.id) : undefined;
        if (source?.kind === "product") {
          catalog.products.push(source.value);
          products.set(source.value.handle, value as LiquidRecord);
        }
        if (source?.kind === "page") {
          catalog.pages.push(source.value);
          pages.set(source.value.handle, value as LiquidRecord);
        }
        if (source?.kind === "blog" && descriptor) {
          const list = await this.list({ relation: "blog-articles", owner: descriptor });
          if (!list)
            throw new RenderSourceError(
              "PREVIEW_SOURCE_INCOMPLETE",
              "Search articles were not captured",
            );
          const entries = new Map<string, LiquidRecord>(),
            sources: Snapshot["blogs"][number]["articles"] = [];
          for (const article of await materializeList(list)) {
            if (!article || typeof article !== "object") continue;
            const descriptor = this.descriptorByObject.get(article),
              source = descriptor ? this.session.values.get(descriptor.id) : undefined;
            if (source?.kind === "article") {
              entries.set(source.value.handle, article as LiquidRecord);
              sources.push(source.value);
            }
          }
          articles.set(source.value.handle, entries);
          catalog.blogs.push({ ...source.value, articles: sources });
        }
      }
    }
    return liquidSearch(
      this.header,
      catalog,
      products,
      pages,
      articles,
      this.route,
      this.hooks,
      this.tracked,
    );
  }
}
