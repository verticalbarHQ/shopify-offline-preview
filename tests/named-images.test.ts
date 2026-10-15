import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { checkTheme } from "../packages/check/src/index.js";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { parseSnapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { extractCorpusOutput, prepareCorpus } from "../tools/oracle/corpus.js";

function snapshot() {
  return {
    ...defaultFixture(),
    images: [
      {
        filename: "own header.png",
        file: "uploaded/header.png",
        alt: "Own & header",
        width: 64,
        height: 64,
        id: "101",
        focalPoint: { x: "0.019231", y: "0.097917" },
      },
    ],
  };
}
function theme(source: string, settings: Record<string, unknown> = {}) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": JSON.stringify({
      sections: { main: { type: "main", settings } },
      order: ["main"],
    }),
    "sections/main.liquid": source,
  };
}
async function render(source: string, settings: Record<string, unknown> = {}) {
  return renderTheme(new MemoryThemeFileSystem(theme(source, settings)), "/", {
    snapshot: snapshot(),
    inspect: true,
  });
}

test("uploaded images resolve by explicit filename with source metadata, local URLs and focal points", async () => {
  const result = await render(
    `{% assign image=images['own header.png'] %}{{image.id}}|{{image.width}}|{{image.height}}|{{image.position|json}}|{{image.media_type}}|{{image.preview_image.id|json}}|{{image.preview_image.media_type|json}}|{{image.product_id|json}}|{{image.variants|json}}|{{image.attached_to_variant?|json}}|{{image.url|json}}|{{image.presentation.focal_point}}|{{image.presentation|json}}|{{image|image_url:width:64|image_tag}}`,
  );
  assert.ok(
    result.html.includes("101|64|64|null|image|null|null|null|null|null|null|1.9231% 9.7917%"),
  );
  assert.ok(result.html.includes('{"focalPoint":{"x":"0.019231","y":"0.097917"}}'));
  assert.ok(result.html.includes('src="/sop/images/uploaded/header.png?width=64"'));
  assert.ok(result.html.includes('alt="Own &amp; header"'));
  assert.ok(result.html.includes('style="object-position:1.9231% 9.7917%;"'));
  assert.deepEqual(result.diagnostics, []);
  const used = Object.values(result.dataUsed).flat();
  for (const field of [
    "images[0].id",
    "images[0].width",
    "images[0].height",
    "images[0].file",
    "images[0].focalPoint.x",
    "images[0].focalPoint.y",
  ])
    assert.ok(used.includes(field), field);
});

test("missing uploaded image lookups are truthy empty drops with native default, size and JSON behavior", async () => {
  const result = await render(
    `{% assign absent=images['absent.png'] %}{% if absent == nil %}nil{% else %}not-nil{% endif %}|{% if absent %}truthy{% endif %}|{% if absent == blank %}blank{% endif %}|{% if absent == empty %}empty{% endif %}|{% if absent == '' %}wrong{% else %}not-string-empty{% endif %}|{{absent}}|{{absent.src|json}}|{{absent.width|json}}|{{absent|default:'fallback'}}|{{absent|size}}|{{absent|json}}|{{images|json}}|{{images}}|{% for image in images %}wrong{% else %}no-items{% endfor %}`,
  );
  assert.ok(
    result.html.includes(
      'not-nil|truthy|blank|empty|not-string-empty|EmptyDrop|""|""|fallback|0|{"error":"json not allowed for this object"}|{"error":"json not allowed for this object"}|ImagesDrop|no-items',
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
  const bad = await render("{{images[0]}}|{{images['absent.png']|image_url:width:64}}");
  assert.equal(bad.diagnostics.filter((d) => d.code === "liquid-error").length, 2);
});

test("image picker settings resolve supplied upload URIs while preserving image objects through default", async () => {
  const schema = `{% schema %}{"settings":[{"id":"banner","type":"image_picker"},{"id":"empty","type":"image_picker"}]}{% endschema %}`;
  const result = await render(
    `{% assign selected=section.settings.banner|default:'fallback' %}{{selected.width}}|{{selected.alt}}|{{selected|image_url:width:64|image_tag}}|{{section.settings.empty|json}}${schema}`,
    { banner: "shopify://shop_images/own%20header.png", empty: "" },
  );
  assert.ok(result.html.includes("64|Own & header|<img "));
  assert.ok(result.html.includes("|null"));
  assert.deepEqual(result.diagnostics, []);
  const missing = await render(`{{section.settings.banner|json}}${schema}`, {
    banner: "shopify://shop_images/absent.png",
  });
  assert.ok(missing.html.includes("null"));
  assert.equal(missing.diagnostics.filter((d) => d.code === "missing-resource").length, 1);
  assert.equal(missing.diagnostics.filter((d) => d.code === "not-implemented").length, 0);
});

test("unsupplied image source metadata remains diagnosed and does not borrow product images", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(theme("{{images['pattern-01.png'].width}}")),
    "/",
    { snapshot: defaultFixture() },
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "not-implemented").length, 1);
  const input = snapshot();
  const first = input.images[0];
  assert.ok(first);
  const { id: _id, ...withoutId } = first;
  const missingId = await renderTheme(
    new MemoryThemeFileSystem(theme("{{images['own header.png'].id|json}}")),
    "/",
    { snapshot: { ...input, images: [withoutId] } },
  );
  assert.equal(missingId.diagnostics.filter((d) => d.code === "not-implemented").length, 1);
});

test("image metadata validates filenames, coordinates, duplicates and conflicts for shared local bytes", () => {
  for (const filename of [
    "",
    "..",
    ".",
    "folder/file.png",
    "bad\\file.png",
    "bad\0file",
    "bad\nfile",
  ]) {
    const input = snapshot();
    const image = input.images[0];
    assert.ok(image);
    image.filename = filename;
    assert.throws(() => parseSnapshot(JSON.stringify(input)));
  }
  for (const x of ["-0.1", "1.1", "NaN", "1e-2"]) {
    const input = snapshot();
    const image = input.images[0];
    assert.ok(image);
    image.focalPoint.x = x;
    assert.throws(() => parseSnapshot(JSON.stringify(input)));
  }
  const duplicate = snapshot();
  const first = duplicate.images[0];
  assert.ok(first);
  duplicate.images.push({ ...first });
  assert.throws(() => validateSnapshotReferences(duplicate), /Duplicate uploaded image filename/);
  const conflict = snapshot();
  const conflictingImage = conflict.images[0];
  assert.ok(conflictingImage);
  conflictingImage.file = "pattern-01.png";
  assert.throws(() => validateSnapshotReferences(conflict), /Conflicting image metadata/);
});

test("static images filename lookups resolve to image properties rather than arbitrary directory keys", async () => {
  const result = await checkTheme(
    new MemoryThemeFileSystem(
      theme(
        "{{images['own header.png'].width}}{{images['own header.png'].presentation.focal_point}}",
      ),
    ),
  );
  const features = result.pages[0]?.features ?? [];
  assert.ok(features.some((f) => f.name === "image.width"));
  assert.ok(features.some((f) => f.name === "image.presentation"));
  assert.ok(features.some((f) => f.name === "image_presentation.focal_point"));
  assert.ok(!features.some((f) => f.name === "images.own header.png"));
});

test("global and section dynamic image pickers preserve typed images and diagnose unsupplied presentation", async () => {
  const files = theme(
    `{{settings.banner.width}}|{{section.settings.banner.width}}|{{section.settings.banner|image_url:width:64|image_tag}}{% schema %}{"settings":[{"id":"banner","type":"image_picker"}]}{% endschema %}`,
    { banner: "{{ images['own header.png'] }}" },
  );
  const fs = new MemoryThemeFileSystem({
    ...files,
    "config/settings_schema.json": '[{"settings":[{"id":"banner","type":"image_picker"}]}]',
    "config/settings_data.json": JSON.stringify({
      current: { banner: "{{ 'shopify://shop_images/own%20header.png' }}" },
    }),
  });
  const result = await renderTheme(fs, "/", { snapshot: snapshot(), inspect: true });
  assert.ok(result.html.includes("64|64|<img "));
  assert.deepEqual(result.diagnostics, []);
  const input = snapshot();
  const first = input.images[0];
  assert.ok(first);
  const { focalPoint: _point, ...withoutPoint } = first;
  const missing = await renderTheme(
    new MemoryThemeFileSystem(theme("{{images['own header.png']|image_url:width:64|image_tag}}")),
    "/",
    { snapshot: { ...input, images: [withoutPoint] } },
  );
  assert.equal(missing.diagnostics.filter((d) => d.code === "not-implemented").length, 1);
});

test("named image objects, missing drops and picker settings match the browser bundle byte for byte", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const files = theme(
    `{% assign picked=section.settings.banner|default:nil %}{{picked.width}}|{{picked.presentation|json}}|{{picked|image_url:width:64|image_tag}}|{{images['absent.png']|default:'fallback'}}|{% if images['absent.png']==blank %}blank{% endif %}|{% for image in images %}wrong{% else %}no-items{% endfor %}|{% if images == blank %}wrong{% else %}nonblank{% endif %}|{{images['own header.png'].preview_image.presentation|json}}|{{images['own header.png'].preview_image|image_url:width:64|default:nil|image_tag}}{% schema %}{"settings":[{"id":"banner","type":"image_picker"}]}{% endschema %}`,
    { banner: "shopify://shop_images/own%20header.png" },
  );
  const options = { snapshot: snapshot(), inspect: true };
  assert.equal(
    JSON.stringify(
      await browser.renderTheme(new browser.MemoryThemeFileSystem(files), "/", options),
    ),
    JSON.stringify(await renderTheme(new MemoryThemeFileSystem(files), "/", options)),
  );
});

test("the original global-image corpus example replays with explicitly supplied fixture metadata", async () => {
  const corpus = JSON.parse(await readFile("packages/spec/src/generated/corpus.json", "utf8"));
  const original = corpus.find((item: { id: string }) => item.id === "filters/image_tag/2");
  assert.ok(original);
  const prepared = prepareCorpus([original], { "/": "/" });
  const item = prepared.cases[0];
  assert.ok(item);
  const input = snapshot();
  const uploaded = input.images[0];
  assert.ok(uploaded);
  uploaded.filename = "potions-header.png";
  const result = await renderTheme(new MemoryThemeFileSystem(prepared.files), item.requestPath, {
    snapshot: input,
  });
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.file, diagnostic.severity]),
    [["shopify-server-only", "layout/sop-corpus.liquid", "info"]],
  );
  assert.ok(
    extractCorpusOutput(result.html, item).includes(
      '<img src="/sop/images/uploaded/header.png?width=64"',
    ),
  );
  assert.equal(item.liquid, original.liquid);
});

test("image directories stay nonblank without enumerating uploads and preview images have no presentation", async () => {
  const result = await render(
    `{% if images == blank %}wrong{% else %}not-blank{% endif %}|{% if blank == images %}wrong{% else %}not-blank{% endif %}|{% if images == empty %}wrong{% else %}not-empty{% endif %}|{% if empty == images %}wrong{% else %}not-empty{% endif %}|{% assign directory=images|default:nil %}{{directory['own header.png'].width}}|{% for image in directory %}wrong{% else %}no-items{% endfor %}|{{images['own header.png'].preview_image.presentation|json}}`,
  );
  assert.ok(
    result.html.includes("not-blank|not-blank|not-empty|not-empty|64|no-items|null"),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});

test("preview image URL results retain their presentation scope through assign and default", async () => {
  const result = await render(
    `{% assign root=images['own header.png'] %}{% assign preview_url=root.preview_image|image_url:width:64 %}ROOT={{root|image_url:width:64|image_tag}}|PREVIEW={{preview_url|default:nil|image_tag}}|PRELOAD={{preview_url|preload_tag:as:'image'}}`,
  );
  const [root, preview, preload] = result.html.split("|");
  assert.ok(root?.includes('style="object-position:1.9231% 9.7917%;"'));
  assert.ok(preview?.includes("<img "));
  assert.ok(!preview?.includes("object-position"));
  assert.ok(preload?.includes('href="/sop/images/uploaded/header.png?width=64"'));
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["shopify-server-only"],
  );
});
