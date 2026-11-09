import { z } from "zod";
import { lazyList } from "./lazy-list.js";
import {
  type RenderAsset,
  type RenderDescriptor,
  type RenderListQuery,
  type RenderResource,
  type RenderResourceKind,
  type RenderSource,
  RenderSourceError,
  type RenderSourceHeader,
} from "./render-source.js";
import { snapshotSchema } from "./schema.js";

const headerSchema = snapshotSchema
  .pick({
    meta: true,
    shop: true,
    cart: true,
    filters: true,
    localization: true,
    placeholderSvgs: true,
    paymentTypeSvgs: true,
  })
  .extend({
    identity: z.string().min(1),
    counts: z.object({
      products: z.number().int().nonnegative(),
      collections: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      blogs: z.number().int().nonnegative(),
      articles: z.number().int().nonnegative(),
      menus: z.number().int().nonnegative(),
      metaobjects: z.number().int().nonnegative(),
    }),
    coverage: z.record(
      z.enum(["product", "collection", "page", "blog", "article", "menu", "metaobject"]),
      z.enum(["complete", "not-captured", "incomplete"]),
    ),
  });
const resourceSchemas = {
  product: snapshotSchema.shape.products.element,
  collection: snapshotSchema.shape.collections.element.omit({
    products: true,
    missingProducts: true,
  }),
  page: snapshotSchema.shape.pages.element,
  blog: snapshotSchema.shape.blogs.element.omit({ articles: true }),
  article: snapshotSchema.shape.blogs.element.shape.articles.element,
  menu: snapshotSchema.shape.menus.element,
  metaobject: snapshotSchema.shape.metaobjects.element,
};
export function resourcePath(descriptor: RenderDescriptor): string {
  return descriptor.kind === "article"
    ? `blogs[${descriptor.blog?.position}].articles[${descriptor.position}]`
    : `${descriptor.kind === "menu" ? "menus" : descriptor.kind === "metaobject" ? "metaobjects" : `${descriptor.kind}s`}[${descriptor.position}]`;
}
/** All caches are render-local and scoped to one authenticated immutable source. */
export class SourceSession {
  private readonly resources = new Map<string, Promise<RenderResource>>();
  private readonly lookups = new Map<string, Promise<RenderDescriptor | null | undefined>>();
  private readonly lists = new Map<string, Promise<unknown[] | undefined>>();
  private readonly listDiagnostics = new Map<string, readonly string[]>();
  private readonly assets = new Map<string, Promise<RenderAsset>>();
  asset(key: string): Promise<RenderAsset> {
    this.signal.throwIfAborted();
    if (key === "") return Promise.resolve({ state: "absent" });
    let pending = this.assets.get(key);
    if (!pending) {
      pending = this.io(() => this.source.asset(key, this.signal));
      this.assets.set(key, pending);
    }
    return pending;
  }
  readonly values = new Map<string, RenderResource>();
  constructor(
    readonly source: RenderSource,
    readonly signal: AbortSignal,
    readonly io: <T>(read: () => Promise<T>) => Promise<T>,
    private readonly record?: (value: unknown) => void,
  ) {}
  async header(): Promise<RenderSourceHeader> {
    const header = await this.io(() => this.source.header(this.signal));
    const parsed = headerSchema.safeParse(header);
    if (!parsed.success)
      throw new RenderSourceError(
        "PREVIEW_SOURCE_INVALID",
        `Invalid source header: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    this.record?.(header);
    for (const count of Object.values(header.counts))
      if (!Number.isSafeInteger(count) || count < 0)
        throw new RenderSourceError("PREVIEW_SOURCE_INVALID", "Invalid resource count");
    return header;
  }
  resolve(kind: RenderResourceKind, key: string): Promise<RenderDescriptor | null | undefined> {
    this.signal.throwIfAborted();
    if (key === "") return Promise.resolve(null);
    const identity = JSON.stringify([kind, key]);
    let pending = this.lookups.get(identity);
    if (!pending) {
      pending = this.io(() => this.source.resolve(kind, key, this.signal)).then((result) => {
        if (result.state === "present") return result.descriptor;
        if (result.state === "absent") return null;
        return undefined;
      });
      this.lookups.set(identity, pending);
    }
    return pending;
  }
  async read(descriptors: readonly RenderDescriptor[]): Promise<RenderResource[]> {
    const missing = descriptors.filter(
      (descriptor, index) =>
        !this.resources.has(descriptor.id) &&
        descriptors.findIndex((value) => value.id === descriptor.id) === index,
    );
    for (let offset = 0; offset < missing.length; offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const pending = this.io(() => this.source.read(batch, this.signal)).then((values) => {
        if (values.length !== batch.length)
          throw new RenderSourceError(
            "PREVIEW_SOURCE_INVALID",
            "Resource batch has the wrong length",
          );
        return values.map((resource, index) => {
          const descriptor = batch[index];
          if (!descriptor || descriptor.kind !== resource.kind)
            throw new RenderSourceError(
              "PREVIEW_SOURCE_INVALID",
              "Resource kind does not match its descriptor",
            );
          const parsed = resourceSchemas[resource.kind].safeParse(resource.value);
          if (!parsed.success)
            throw new RenderSourceError(
              "PREVIEW_SOURCE_INVALID",
              `Invalid ${resource.kind}: ${parsed.error.message}`,
              { cause: parsed.error },
            );
          const value = parsed.data;
          this.record?.(value);
          const validated = { kind: resource.kind, value } as RenderResource;
          this.values.set(descriptor.id, validated);
          return validated;
        });
      });
      batch.forEach((descriptor, index) => {
        this.resources.set(
          descriptor.id,
          pending.then((values) => {
            const value = values[index];
            if (!value)
              throw new RenderSourceError(
                "PREVIEW_SOURCE_INVALID",
                "Resource is absent from batch",
              );
            return value;
          }),
        );
      });
    }
    return Promise.all(
      descriptors.map((descriptor) => {
        const pending = this.resources.get(descriptor.id);
        if (!pending)
          throw new RenderSourceError("PREVIEW_SOURCE_INVALID", "Resource read was not scheduled");
        return pending;
      }),
    );
  }
  list(
    query: Omit<RenderListQuery, "offset" | "limit">,
    hydrate: (descriptor: RenderDescriptor, resource: RenderResource) => unknown,
    diagnostic: (message: string) => void,
    reportDiagnostics = true,
  ): Promise<unknown[] | undefined> {
    const key = JSON.stringify(query);
    const report = (pending: Promise<unknown[] | undefined>) =>
      pending.then((list) => {
        if (reportDiagnostics)
          for (const message of this.listDiagnostics.get(key) ?? []) diagnostic(message);
        return list;
      });
    let pending = this.lists.get(key);
    if (pending) return report(pending);
    pending = (async () => {
      const metadata = await this.io(() =>
        this.source.list({ ...query, offset: 0, limit: 0 }, this.signal),
      );
      this.listDiagnostics.set(key, metadata.diagnostics ?? []);
      if (metadata.state !== "complete" || metadata.total === null) {
        diagnostic(`${query.relation} is ${metadata.state}`);
        return undefined;
      }
      const total = metadata.total;
      if (!Number.isSafeInteger(total) || total < 0)
        throw new RenderSourceError("PREVIEW_SOURCE_INVALID", "Invalid relationship total");
      return lazyList(
        total,
        async (start, length, direction) => {
          const offset = direction === 1 ? start : start - length + 1;
          const list = await this.io(() =>
            this.source.list({ ...query, offset, limit: length }, this.signal),
          );
          if (
            list.state !== "complete" ||
            list.total !== total ||
            list.entries.length !== length ||
            list.entries.some((entry, index) => entry.ordinal !== offset + index)
          )
            throw new RenderSourceError(
              "PREVIEW_SOURCE_INVALID",
              "Relationship range is incomplete or changed during render",
            );
          const descriptors = list.entries.flatMap((entry) =>
            entry.state === "present" ? [entry.descriptor] : [],
          );
          const values = await this.read(descriptors);
          let position = 0;
          const result = list.entries.map((entry) =>
            entry.state === "missing"
              ? null
              : hydrate(entry.descriptor, values[position++] as RenderResource),
          );
          return direction === 1 ? result : result.reverse();
        },
        0,
        1,
        async (start, length, direction) => {
          if (metadata.missingCount === 0 || length === 0) return false;
          if (length === total && metadata.missingCount !== undefined)
            return metadata.missingCount > 0;
          const offset = direction === 1 ? start : start - length + 1;
          for (let position = 0; position < length; position += 100) {
            const list = await this.io(() =>
              this.source.list(
                { ...query, offset: offset + position, limit: Math.min(100, length - position) },
                this.signal,
              ),
            );
            if (list.state !== "complete" || list.total !== total)
              throw new RenderSourceError(
                "PREVIEW_SOURCE_INVALID",
                "Relationship changed during render",
              );
            if (list.entries.some((entry) => entry.state === "missing")) return true;
          }
          return false;
        },
      );
    })();
    this.lists.set(key, pending);
    return report(pending);
  }
}
