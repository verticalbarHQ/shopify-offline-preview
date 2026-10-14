import { Drop } from "liquidjs";
import type { Snapshot } from "./schema.js";

export type NamedImage = NonNullable<Snapshot["images"]>[number];
type SourceImage = Snapshot["products"][number]["images"][number] &
  Partial<Pick<NamedImage, "filename" | "id" | "focalPoint">>;
export function snapshotImageEntries(snapshot: Snapshot): [string, SourceImage][] {
  return [
    ...snapshot.products.flatMap((product, index) =>
      product.images.map((image, imageIndex): [string, SourceImage] => [
        `products[${index}].images[${imageIndex}]`,
        image,
      ]),
    ),
    ...snapshot.collections.flatMap((collection, index): [string, SourceImage][] =>
      collection.image ? [[`collections[${index}].image`, collection.image]] : [],
    ),
    ...snapshot.blogs.flatMap((blog, index) =>
      blog.articles.flatMap((article, articleIndex): [string, SourceImage][] =>
        article.image ? [[`blogs[${index}].articles[${articleIndex}].image`, article.image]] : [],
      ),
    ),
    ...(snapshot.images ?? []).map((image, index): [string, SourceImage] => [
      `images[${index}]`,
      image,
    ]),
  ];
}
export function snapshotImages(snapshot: Snapshot): SourceImage[] {
  return snapshotImageEntries(snapshot).map(([, image]) => image);
}
export function localImageUrl(file: string): string {
  return `/sop/images/${file.split("/").map(encodeURIComponent).join("/")}`;
}
export function focalPointPercent(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const amount = (BigInt(whole) * scale + BigInt(fraction || "0")) * 100n;
  const decimals = (amount % scale).toString().padStart(fraction.length, "0").replace(/0+$/, "");
  return `${amount / scale}${decimals ? `.${decimals}` : ""}%`;
}
/** Native missing image lookups are truthy empty drops, distinct from a nil picker setting. */
export class MissingImage extends Drop {
  valueOf() {
    return this;
  }
  toString() {
    return "EmptyDrop";
  }
  *[Symbol.iterator](): Generator<never> {}
  liquidMethodMissing() {
    return "";
  }
  *equals(other: unknown): Generator<unknown, boolean, unknown> {
    if (other instanceof MissingImage) return true;
    if (other instanceof Drop && typeof other.equals === "function")
      return (yield other.equals("")) === true;
    return false;
  }
}
export class NamedImageDrop extends Drop {
  #source: NamedImage;
  #path: string;
  #read: (path: string) => void;
  #unsupported: (property: string) => void;
  #preview: boolean;
  constructor(
    source: NamedImage,
    path: string,
    read: (path: string) => void,
    unsupported: (property: string) => void,
    preview = false,
  ) {
    super();
    this.#source = source;
    this.#path = path;
    this.#read = read;
    this.#unsupported = unsupported;
    this.#preview = preview;
  }
  #field(key: "file" | "alt" | "width" | "height" | "id") {
    this.#read(`${this.#path}.${key}`);
    if (!Object.hasOwn(this.#source, key)) this.#unsupported(key);
    return this.#source[key];
  }
  get src() {
    return localImageUrl(String(this.#field("file")));
  }
  get url() {
    return null;
  }
  get alt() {
    return this.#field("alt");
  }
  get width() {
    return this.#field("width");
  }
  get height() {
    return this.#field("height");
  }
  get aspect_ratio() {
    return Number(this.width) / Number(this.height);
  }
  get id() {
    if (this.#preview) return null;
    const value = this.#field("id");
    if (typeof value !== "string") return undefined;
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
  }
  get position() {
    return null;
  }
  get product_id() {
    return null;
  }
  get variants() {
    return null;
  }
  get "attached_to_variant?"() {
    return null;
  }
  get media_type() {
    return this.#preview ? null : "image";
  }
  get preview_image(): NamedImageDrop | null {
    return this.#preview
      ? null
      : new NamedImageDrop(this.#source, this.#path, this.#read, this.#unsupported, true);
  }
  get presentation() {
    if (this.#preview) return null;
    const point = this.#source.focalPoint;
    if (!point) {
      this.#unsupported("presentation");
      return undefined;
    }
    this.#read(`${this.#path}.focalPoint.x`);
    this.#read(`${this.#path}.focalPoint.y`);
    return new ImagePresentation(point, (key) => this.#unsupported(`presentation.${key}`));
  }
  valueOf() {
    return this.src;
  }
  liquidMethodMissing(property: string) {
    this.#unsupported(property);
    return undefined;
  }
}
class ImagePresentation extends Drop {
  #point: NonNullable<NamedImage["focalPoint"]>;
  #unsupported: (key: string) => void;
  constructor(point: NonNullable<NamedImage["focalPoint"]>, unsupported: (key: string) => void) {
    super();
    this.#point = point;
    this.#unsupported = unsupported;
  }
  get focal_point() {
    return `${focalPointPercent(this.#point.x)} ${focalPointPercent(this.#point.y)}`;
  }
  valueOf() {
    return { focalPoint: this.#point };
  }
  liquidMethodMissing(key: string) {
    this.#unsupported(key);
    return undefined;
  }
}
export class ImageDirectory extends Drop {
  #images: Map<string, NamedImageDrop>;
  // LiquidJS treats ordinary empty objects as blank and nonempty strings as
  // one-item collections. An opaque iterable with its own string conversion
  // stays nonblank while yielding no entries through public Drop coercion.
  #opaque = {
    toString: () => "ImagesDrop",
    *[Symbol.iterator](): Generator<never> {},
  };
  #supplied: boolean;
  #read: (path: string) => void;
  #unsupported: (property: string) => void;
  constructor(
    images: Snapshot["images"],
    read: (path: string) => void,
    unsupported: (property: string) => void,
  ) {
    super();
    this.#supplied = images !== undefined;
    this.#read = read;
    this.#unsupported = unsupported;
    this.#images = new Map(
      (images ?? []).map((source, index) => [
        source.filename,
        new NamedImageDrop(source, `images[${index}]`, read, unsupported),
      ]),
    );
  }
  valueOf() {
    return this.#opaque;
  }
  toString() {
    return "ImagesDrop";
  }
  *[Symbol.iterator](): Generator<never> {}
  liquidMethodMissing(filename: string | number) {
    if (typeof filename !== "string") throw new Error("Expected image filename to be a String");
    this.#read("images");
    if (!this.#supplied) this.#unsupported("images source metadata");
    return this.#images.get(filename) ?? new MissingImage();
  }
}
