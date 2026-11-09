import { snapshotImageEntries } from "../../packages/data/src/images.js";
import type {
  RenderAsset,
  RenderDescriptor,
  RenderList,
  RenderListQuery,
  RenderLookup,
  RenderResource,
  RenderResourceKind,
  RenderSource,
  RenderSourceHeader,
} from "../../packages/data/src/render-source.js";
import type { Snapshot } from "../../packages/data/src/schema.js";

/** Test adapter retains complete membership metadata while recording every normalized body read. */
export class FixtureRenderSource implements RenderSource {
  readonly reads: RenderDescriptor[][] = [];
  readonly lists: RenderListQuery[] = [];
  readonly resolutions: [RenderResourceKind, string][] = [];
  private readonly resources = new Map<string, RenderResource>();
  private readonly descriptors = new Map<string, RenderDescriptor>();
  constructor(readonly snapshot: Snapshot) {
    const add = (
      resource: RenderResource,
      key: string,
      position: number,
      blog?: { handle: string; position: number },
    ) => {
      const id = JSON.stringify([resource.kind, key]);
      const descriptor: RenderDescriptor = {
        kind: resource.kind,
        id,
        key,
        position,
        ...("templateSuffix" in resource.value
          ? { templateSuffix: resource.value.templateSuffix }
          : {}),
        ...(blog ? { blog } : {}),
      };
      this.resources.set(id, resource);
      this.descriptors.set(id, descriptor);
    };
    for (const [index, value] of snapshot.products.entries())
      add({ kind: "product", value }, value.handle, index);
    for (const [index, collection] of snapshot.collections.entries()) {
      const { products: _products, missingProducts: _missing, ...value } = collection;
      add({ kind: "collection", value }, value.handle, index);
    }
    for (const [index, value] of snapshot.pages.entries())
      add({ kind: "page", value }, value.handle, index);
    for (const [index, blog] of snapshot.blogs.entries()) {
      const { articles, ...value } = blog;
      add({ kind: "blog", value }, value.handle, index);
      for (const [position, article] of articles.entries())
        add(
          { kind: "article", value: article },
          JSON.stringify([value.handle, article.handle]),
          position,
          { handle: value.handle, position: index },
        );
    }
    for (const [index, value] of snapshot.menus.entries())
      add({ kind: "menu", value }, value.handle, index);
    for (const [index, value] of snapshot.metaobjects.entries())
      add({ kind: "metaobject", value }, JSON.stringify([value.type, value.handle]), index);
  }
  async header(): Promise<RenderSourceHeader> {
    const { meta, shop, cart, filters, localization, placeholderSvgs, paymentTypeSvgs } =
      this.snapshot;
    return {
      identity: "fixture",
      meta,
      shop,
      cart,
      filters,
      localization,
      placeholderSvgs,
      paymentTypeSvgs,
      counts: {
        products: this.snapshot.products.length,
        collections: this.snapshot.collections.length,
        pages: this.snapshot.pages.length,
        blogs: this.snapshot.blogs.length,
        articles: this.snapshot.blogs.reduce((sum, blog) => sum + blog.articles.length, 0),
        menus: this.snapshot.menus.length,
        metaobjects: this.snapshot.metaobjects.length,
      },
      coverage: {
        product: "complete",
        collection: "complete",
        page: "complete",
        blog: "complete",
        article: "complete",
        menu: "complete",
        metaobject: "complete",
      },
    };
  }
  async resolve(kind: RenderResourceKind, key: string): Promise<RenderLookup> {
    this.resolutions.push([kind, key]);
    const descriptor = this.descriptors.get(JSON.stringify([kind, key]));
    return descriptor ? { state: "present", descriptor } : { state: "absent" };
  }
  async list(query: RenderListQuery): Promise<RenderList> {
    this.lists.push(query);
    let kind: RenderResourceKind;
    let keys: string[] | undefined;
    switch (query.relation) {
      case "collection-products":
        kind = "product";
        keys = this.snapshot.collections.find(
          (value) => value.handle === query.owner?.key,
        )?.products;
        break;
      case "product-collections":
        kind = "collection";
        keys = this.snapshot.collections.some((value) => value.products === undefined)
          ? undefined
          : this.snapshot.collections
              .filter((value) => value.products?.includes(query.owner?.key ?? ""))
              .map((value) => value.handle);
        break;
      case "blog-articles": {
        kind = "article";
        const blog = this.snapshot.blogs.find((value) => value.handle === query.owner?.key);
        keys =
          blog &&
          (blog.articles.some((value) => value.publishedAt === undefined)
            ? blog.articles
            : [...blog.articles].sort(
                (a, b) =>
                  Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") ||
                  (a.id && b.id && /^\d+$/.test(a.id) && /^\d+$/.test(b.id)
                    ? BigInt(a.id) < BigInt(b.id)
                      ? 1
                      : BigInt(a.id) > BigInt(b.id)
                        ? -1
                        : 0
                    : 0),
              )
          ).map((value) => JSON.stringify([blog.handle, value.handle]));
        break;
      }
      case "all-collection-products":
        kind = "product";
        keys = [...this.snapshot.products]
          .sort((a, b) =>
            new Intl.Collator(this.snapshot.shop.locale, { sensitivity: "base" }).compare(
              a.title,
              b.title,
            ),
          )
          .map((value) => value.handle);
        break;
      default:
        kind = (
          {
            products: "product",
            collections: "collection",
            pages: "page",
            blogs: "blog",
            menus: "menu",
            metaobjects: "metaobject",
          } as const
        )[query.relation];
        keys = [...this.descriptors.values()]
          .filter(
            (value) =>
              value.kind === kind &&
              (query.type === undefined || JSON.parse(value.key)[0] === query.type),
          )
          .map((value) => value.key);
    }
    if (!keys) return { state: "not-captured", total: null, entries: [] };
    return {
      state: "complete",
      total: keys.length,
      missingCount: keys.filter((key) => !this.descriptors.has(JSON.stringify([kind, key]))).length,
      entries: keys.slice(query.offset, query.offset + query.limit).map((key, index) => {
        const descriptor = this.descriptors.get(JSON.stringify([kind, key]));
        return descriptor
          ? { ordinal: query.offset + index, state: "present", descriptor }
          : { ordinal: query.offset + index, state: "missing", key };
      }),
    };
  }
  async read(descriptors: readonly RenderDescriptor[]): Promise<RenderResource[]> {
    this.reads.push([...descriptors]);
    return descriptors.map((descriptor) => {
      const value = this.resources.get(descriptor.id);
      if (!value) throw new Error("Test resource missing");
      return value;
    });
  }
  async asset(key: string): Promise<RenderAsset> {
    const matches = snapshotImageEntries(this.snapshot).filter(
      ([, image]) => image.file === key || image.filename === key,
    );
    const image = matches.at(-1)?.[1];
    return image
      ? { state: "present", image: { ...image, filename: image.filename ?? image.file } }
      : { state: "absent" };
  }
}
