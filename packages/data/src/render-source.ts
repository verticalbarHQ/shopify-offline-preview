import type { Snapshot } from "./schema.js";

export type RenderResourceKind =
  | "product"
  | "collection"
  | "page"
  | "blog"
  | "article"
  | "menu"
  | "metaobject";
export type RenderRelation =
  | "products"
  | "collections"
  | "pages"
  | "blogs"
  | "menus"
  | "metaobjects"
  | "collection-products"
  | "product-collections"
  | "blog-articles"
  | "all-collection-products";

/** An immutable resource identity, with its original position for data provenance. */
export interface RenderDescriptor {
  kind: RenderResourceKind;
  id: string;
  /** Handle; articles use JSON.stringify([blogHandle, handle]), metaobjects [type, handle]. */
  key: string;
  position: number;
  templateSuffix?: string | null;
  /** Articles also name their parent position without reading that parent's body. */
  blog?: { handle: string; position: number };
}
export type RenderLookup =
  | { state: "present"; descriptor: RenderDescriptor }
  | { state: "absent" }
  | { state: "not-captured" | "incomplete" };

export type RenderCommon = Pick<
  Snapshot,
  "meta" | "shop" | "cart" | "filters" | "localization" | "placeholderSvgs" | "paymentTypeSvgs"
>;
export interface RenderSourceHeader extends RenderCommon {
  identity: string;
  counts: Record<
    "products" | "collections" | "pages" | "blogs" | "articles" | "menus" | "metaobjects",
    number
  >;
  coverage: Record<RenderResourceKind, "complete" | "not-captured" | "incomplete">;
}
export interface RenderListQuery {
  relation: RenderRelation;
  owner?: RenderDescriptor;
  /** Used only by the metaobjects relation. */
  type?: string;
  offset: number;
  limit: number;
}
export interface RenderList {
  state: "complete" | "not-captured" | "incomplete";
  total: number | null;
  /** Captured missing membership slots, computed without reading resource bodies. */
  missingCount?: number;
  entries: (
    | { ordinal: number; state: "present"; descriptor: RenderDescriptor }
    | { ordinal: number; state: "missing"; key: string }
  )[];
  /** Existing materialized diagnostics, e.g. absent article publication order. */
  diagnostics?: string[];
}
export type RenderResource =
  | { kind: "product"; value: Snapshot["products"][number] }
  | {
      kind: "collection";
      value: Omit<Snapshot["collections"][number], "products" | "missingProducts">;
    }
  | { kind: "page"; value: Snapshot["pages"][number] }
  | { kind: "blog"; value: Omit<Snapshot["blogs"][number], "articles"> }
  | { kind: "article"; value: Snapshot["blogs"][number]["articles"][number] }
  | { kind: "menu"; value: Snapshot["menus"][number] }
  | { kind: "metaobject"; value: Snapshot["metaobjects"][number] };
export type RenderAsset =
  | { state: "present"; image: NonNullable<Snapshot["images"]>[number] }
  | { state: "absent" | "ambiguous" | "not-captured" };

/** A source is scoped to one immutable snapshot and one authenticated render session. */
export interface RenderSource {
  header(signal: AbortSignal): Promise<RenderSourceHeader>;
  resolve(kind: RenderResourceKind, key: string, signal: AbortSignal): Promise<RenderLookup>;
  list(query: RenderListQuery, signal: AbortSignal): Promise<RenderList>;
  /** Batched reads preserve order and include the normalized resource's required children. */
  read(descriptors: readonly RenderDescriptor[], signal: AbortSignal): Promise<RenderResource[]>;
  asset(key: string, signal: AbortSignal): Promise<RenderAsset>;
}

/** Source transport/contract failures cannot be converted into inline Liquid diagnostics. */
export class RenderSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RenderSourceError";
  }
}
