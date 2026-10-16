import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { parseSnapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { buildOracleSeedPlan } from "../tools/oracle/seed-plan.js";

function setup(source: string) {
  const snapshot = defaultFixture(),
    product = snapshot.products[0];
  assert.ok(product);
  const original = product.images[0];
  assert.ok(original);
  product.id = "4100";
  product.images = [
    {
      ...original,
      id: "5100",
      mediaId: "6100",
      alt: "Classic alt",
      mediaAlt: null,
      previewAlt: "Preview alt",
    },
  ];
  for (const [index, variant] of product.variants.entries()) {
    variant.id = String(7100 + index);
    variant.image = index === 0 ? original.file : null;
  }
  const fs = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/product.json": JSON.stringify({
      sections: { main: { type: "main" } },
      order: ["main"],
    }),
    "sections/main.liquid": source,
  });
  return { snapshot: parseSnapshot(JSON.stringify(snapshot)), fs, product };
}
test("classic, media and preview preserve independent IDs and contextual image properties", async () => {
  const s = setup(
      `{% assign i=product.images.first %}I={{i.id}}/{{i.position}}/{{i.product_id}}/{{i.media_type|json}}/{{i.preview_image|json}}/{{i.attached_to_variant?|json}}/{{i.variants|map:'id'|join:','}}|{% assign m=product.media.first %}M={{m.id}}/{{m.position}}/{{m.product_id|json}}/{{m.media_type}}/{{m.attached_to_variant?|json}}/{{m.variants|json}}|P={{m.preview_image.id|json}}/{{m.preview_image.position|json}}/{{m.preview_image.product_id|json}}/{{m.preview_image.media_type|json}}/{{m.preview_image.preview_image|json}}|V={{product.variants.first.image.id}}/{{product.variants.first.featured_image.id}}/{{product.variants.first.featured_media.id}}`,
    ),
    result = await renderTheme(s.fs, `/products/${s.product.handle}`, {
      snapshot: s.snapshot,
      inspect: true,
    });
  assert.ok(
    result.html.includes(
      "I=5100/1/4100/null/null/true/7100|M=6100/1/null/image/null/null|P=null/null/null/null/null|V=5100/5100/6100",
    ),
  );
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    0,
  );
});
test("view-specific nullable alt text survives image_url assignment and image_tag, with explicit overrides", async () => {
  const s = setup(
      `CLASSIC={{product.images.first|image_url:width:32|image_tag}}|{% assign media_url=product.media.first|image_url:width:32 %}MEDIA={{media_url|default:nil|image_tag}}|PREVIEW={{product.media.first.preview_image|image_url:width:32|image_tag}}|OVERRIDE={{media_url|image_tag:alt:'Explicit'}}`,
    ),
    result = await renderTheme(s.fs, `/products/${s.product.handle}`, { snapshot: s.snapshot });
  assert.match(result.html, /CLASSIC=<img [^>]*alt="Classic alt"/);
  assert.match(result.html, /MEDIA=<img [^>]*alt=""/);
  assert.match(result.html, /PREVIEW=<img [^>]*alt="Preview alt"/);
  assert.match(result.html, /OVERRIDE=<img [^>]*alt="Explicit"/);
});
test("direct images serialize as local URLs while media JSON contains only native media fields and structured preview data", async () => {
  const s = setup(
      `C={{product.images.first|json}}|M={{product.media.first|json}}|P={{product.media.first.preview_image|json}}|ALL={{product|json}}`,
    ),
    result = await renderTheme(s.fs, `/products/${s.product.handle}`, { snapshot: s.snapshot });
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    0,
  );
  const media = result.html.split("|M=")[1]?.split("|P=")[0];
  assert.ok(media);
  const value = JSON.parse(media);
  assert.equal(value.id, 6100);
  assert.equal(value.alt, null);
  assert.equal(value.media_type, "image");
  assert.deepEqual(Object.keys(value.preview_image).sort(), [
    "aspect_ratio",
    "height",
    "src",
    "width",
  ]);
  assert.equal(Object.hasOwn(value, "file"), false);
  assert.match(result.html, /C="\\\/sop\\\/images\\\//);
});
test("missing media IDs are observed instead of copied from the classic image, and explicit null generic IDs remain null", async () => {
  const s = setup(`ID={{product.media.first.id|json}}`),
    first = s.snapshot.products[0]?.images[0];
  assert.ok(first);
  delete first.mediaId;
  const result = await renderTheme(s.fs, `/products/${s.product.handle}`, {
    snapshot: s.snapshot,
    inspect: true,
  });
  assert.ok(result.html.includes("ID=null"));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "missing-resource" && diagnostic.message.includes("image.id"),
    ),
  );
  first.id = null;
  assert.equal(parseSnapshot(JSON.stringify(s.snapshot)).products[0]?.images[0]?.id, null);
});

test("shared image bytes retain per-product identity and view alt metadata without duplicating uploads", () => {
  const snapshot = defaultFixture(),
    first = snapshot.products[0],
    second = snapshot.products[1];
  assert.ok(first && second && first.images[0]);
  const image = first.images[0];
  first.images = [{ ...image, id: "10", mediaId: "20", mediaAlt: null }];
  second.images = [{ ...image, id: "11", mediaId: "21", previewAlt: "Second preview" }];
  for (const product of [first, second])
    for (const variant of product.variants) variant.image = image.file;
  validateSnapshotReferences(snapshot);
  const plan = buildOracleSeedPlan(
    { domain: "authored-demo.myshopify.com", apiVersion: "2026-10" },
    snapshot,
  );
  assert.ok(!plan.issues.some((issue) => issue.code.includes("image-metadata")));
  for (const state of plan.states) {
    const tasks = state.tasks.filter(
      (task) => task.resource === "image" && task.identity[0] === image.file,
    );
    assert.equal(tasks.length, 1);
    assert.equal(Object.hasOwn(tasks[0]?.source ?? {}, "mediaId"), false);
  }
});

test("independent image views match the browser bundle including diagnostics and source reads", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const s = setup(
      `{{product.images.first|json}}|{{product.media.first|json}}|{{product.media.first.preview_image|image_url:width:32|image_tag}}|{{product.variants.first.featured_media.id}}|{{product|json}}`,
    ),
    files: Record<string, Uint8Array> = {};
  for (const file of await s.fs.listFiles()) files[file] = await s.fs.readBytes(file);
  const options = { snapshot: s.snapshot, inspect: true },
    path = `/products/${s.product.handle}`;
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(files), path, options),
    await renderTheme(s.fs, path, options),
  );
});
