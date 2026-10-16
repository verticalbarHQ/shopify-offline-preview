import { defaultFixture } from "../../data/src/fixture.js";
import { NamedImageDrop } from "../../data/src/images.js";
import {
  type LiquidRecord,
  liquidObjectKind,
  liquidObjects,
  type RouteContext,
  recordObjectTypes,
  unavailableGlobals,
} from "../../data/src/objects.js";
import { applyScenario } from "../../data/src/scenarios.js";
import type { Snapshot } from "../../data/src/schema.js";
import { type ImplementationEvidence, registry } from "../../spec/src/index.js";
import { MemoryThemeFileSystem } from "../../theme/src/index.js";
import { ColorScheme, ColorSchemeGroup, ColorValue } from "./color-settings.js";
import { Font } from "./fonts.js";
import { observeEngines, renderTheme } from "./index.js";
import { TableRowLoop } from "./tablerow-tag.js";

/** Liquid objects implemented as classes: their getters are their properties. */
const drops: [abstract new (...args: never[]) => object, string][] = [
  [ColorValue, "color"],
  [ColorScheme, "color_scheme"],
  [ColorSchemeGroup, "color_scheme_group"],
  [Font, "font"],
  [NamedImageDrop, "image"],
  [TableRowLoop, "tablerowloop"],
];
function getters(prototype: object): string[] {
  return Object.entries(Object.getOwnPropertyDescriptors(prototype)).flatMap(([key, value]) =>
    value.get ? [key] : [],
  );
}

/** The bundled fixture plus data for objects the default matrix does not create. */
function probeSnapshot(): Snapshot {
  const snapshot = applyScenario(defaultFixture(), "with-items");
  const main = snapshot.products[0];
  const color = main?.options[0];
  const image = { file: "pattern-01.png", alt: "Probe", width: 64, height: 64, focalPoint: null };
  if (main) main.metafields = { custom: { probe: { type: "single_line_text_field", value: "x" } } };
  if (color?.swatches) color.swatches[0] = { color: "#ff0000", image };
  if (main)
    main.media = [
      ...main.images.map((entry) => ({ mediaType: "image" as const, file: entry.file })),
      {
        mediaType: "video",
        id: "1",
        alt: null,
        duration: 1000,
        previewImage: image,
        sources: [
          { file: "probe.mp4", format: "mp4", mimeType: "video/mp4", width: 64, height: 64 },
        ],
      },
      {
        mediaType: "external_video",
        id: "2",
        alt: null,
        previewImage: image,
        host: "youtube",
        externalId: "probe",
      },
      {
        mediaType: "model",
        id: "3",
        alt: null,
        previewImage: image,
        sources: [{ file: "probe.glb", format: "glb", mimeType: "model/gltf-binary" }],
      },
    ];
  snapshot.shop.socialSharingImage = image;
  snapshot.shop.policies = [
    { id: "1", title: "Refund policy", body: "<p>Probe</p>", url: "/policies/refund-policy" },
  ];
  const variant = main?.variants[0];
  if (variant) {
    variant.quantityPriceBreaks = [{ minimumQuantity: 2, price: "10.00" }];
    variant.unitPrice = "1.00";
    variant.unitPriceMeasurement = {
      measured_type: "volume",
      quantity_unit: "ml",
      quantity_value: 100,
      reference_unit: "ml",
      reference_value: 100,
    };
  }
  snapshot.metaobjects = [
    {
      type: "probe",
      handle: "one",
      fields: { title: { type: "single_line_text_field", value: "x" } },
    },
  ];
  snapshot.filters = [
    {
      id: "filter.v.availability",
      label: "Availability",
      type: "boolean",
      values: [{ label: "In stock", value: "1" }],
    },
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [{ label: "Example Studio", value: "Example Studio" }],
    },
    { id: "filter.v.price", label: "Price", type: "price_range", values: [] },
  ];
  return snapshot;
}
const routes: (Partial<RouteContext> & Pick<RouteContext, "pageType" | "path">)[] = [
  { pageType: "index", path: "/" },
  { pageType: "product", path: "/products/sop-matrix-needle", resourceHandle: "sop-matrix-needle" },
  {
    pageType: "collection",
    path: "/collections/sop-catalog?filter.v.availability=1",
    resourceHandle: "sop-catalog",
  },
  { pageType: "page", path: "/pages/about", resourceHandle: "about" },
  { pageType: "blog", path: "/blogs/news", resourceHandle: "news" },
  {
    pageType: "article",
    path: "/blogs/news/story-1",
    resourceHandle: "story-1",
    blogHandle: "news",
  },
  { pageType: "search", path: "/search?q=Matrix", q: "Matrix" },
  { pageType: "cart", path: "/cart" },
  { pageType: "404", path: "/missing" },
];
/** Reads every own property, so lazily derived objects are created too. */
function visit(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  media: Set<string>,
  record: (type: string, keys: readonly string[]) => void,
): void {
  if (depth > 8 || value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const kind = liquidObjectKind(value);
  if (kind === "media_image") for (const key of Object.keys(value)) media.add(key);
  // Properties defined after an object was tracked, and getters of class-based objects.
  else if (kind)
    record(kind, [...Object.getOwnPropertyNames(value), ...getters(Object.getPrototypeOf(value))]);
  const items = Array.isArray(value)
    ? value.slice(0, 3)
    : Reflect.ownKeys(value).flatMap((key) => {
        if (typeof key !== "string") return [];
        try {
          return [Reflect.get(value, key)];
        } catch {
          return [];
        }
      });
  for (const item of items) visit(item, depth + 1, seen, media, record);
}
const probeTheme = new MemoryThemeFileSystem({
  "templates/collection.json": JSON.stringify({
    layout: false,
    sections: { probe: { type: "probe", blocks: { b: { type: "probe" } }, block_order: ["b"] } },
    order: ["probe"],
  }),
  "sections/probe.liquid":
    '{% form \'contact\' %}{% endform %}{% paginate collection.products by 2 %}{% endpaginate %}{% schema %}{"blocks":[{"type":"probe","name":"Probe"}]}{% endschema %}',
});

let evidence: Promise<ImplementationEvidence[]> | undefined;
/**
 * Features the offline renderer provides: non-stub filters, tags, and the documented objects and
 * properties its runtime objects expose. Registration is not oracle verification (SPEC §9.10).
 */
export function rendererRegistration(): Promise<ImplementationEvidence[]> {
  evidence ??= (async () => {
    const properties = new Map<string, Set<string>>();
    const add = (type: string, keys: Iterable<string>) => {
      const set = properties.get(type) ?? new Set<string>();
      for (const key of keys) set.add(key);
      properties.set(type, set);
    };
    const globals = new Set<string>();
    let filters = new Set<string>(),
      tags = new Set<string>();
    const media = new Set<string>();
    await recordObjectTypes(add, async () => {
      const snapshot = probeSnapshot();
      const hooks = { read() {}, unsupported() {}, unsupportedOperation() {}, missing() {} };
      for (const route of routes) {
        const objects: LiquidRecord = liquidObjects(
          snapshot,
          {
            variant: null,
            q: "",
            sortBy: null,
            resourceHandle: null,
            designMode: false,
            ...route,
          },
          hooks,
        );
        visit(objects, 0, new WeakSet(), media, add);
      }
      await observeEngines(
        (engine, stubbed) => {
          filters = new Set(Object.keys(engine.filters).filter((name) => !stubbed.has(name)));
          tags = new Set(Object.keys(engine.tags));
          const scope: unknown = engine.options.globals;
          if (scope && typeof scope === "object")
            for (const key of Reflect.ownKeys(scope))
              if (typeof key === "string" && !unavailableGlobals.includes(key)) globals.add(key);
        },
        () => renderTheme(probeTheme, "/collections/sop-catalog", { snapshot }),
      );
    });
    add("media", media);
    for (const [drop, type] of drops) add(type, getters(drop.prototype));
    // LiquidJS provides the loop object; `parentloop` is preserved by the preview's loop tracing.
    add("forloop", Object.keys(registry.objects.forloop?.properties ?? {}));
    for (const name of ["section", "block", "settings", "form", "paginate", "content_for_layout"])
      globals.add(name);
    const objects: Record<string, { properties: Record<string, unknown> }> = registry.objects;
    const result: ImplementationEvidence[] = [];
    const registered = (kind: ImplementationEvidence["kind"], name: string) =>
      result.push({ kind, name, registered: true, oracleCases: [] });
    for (const name of Object.keys(registry.filters).sort())
      if (filters.has(name)) registered("filter", name);
    for (const name of [...Object.keys(registry.tags), "schema"].sort())
      if (tags.has(name)) registered("tag", name);
    for (const type of Object.keys(objects).sort()) {
      if (properties.has(type) || globals.has(type)) registered("object", type);
      const documented = objects[type]?.properties ?? {};
      for (const key of [...(properties.get(type) ?? [])].sort())
        if (Object.hasOwn(documented, key)) registered("object-property", `${type}.${key}`);
    }
    return result;
  })();
  return evidence;
}
