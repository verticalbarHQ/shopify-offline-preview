import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import type { Snapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(template: string, source: string, extra: Record<string, string> = {}) {
  return new MemoryThemeFileSystem({
    [`templates/${template}.json`]:
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
    ...extra,
  });
}
const product = "/products/sop-matrix-needle";
const preview = { file: "pattern-03.png", alt: "Poster", width: 64, height: 32, focalPoint: null };

test("unit_price_with_measurement formats money and omits a reference value of one", async () => {
  const snapshot = defaultFixture();
  const variant = snapshot.products[0]?.variants[0];
  assert.ok(variant);
  variant.unitPrice = "1.25";
  variant.unitPriceMeasurement = {
    measured_type: "volume",
    quantity_unit: "ml",
    quantity_value: 250,
    reference_unit: "ml",
    reference_value: 100,
  };
  const result = await renderTheme(
    theme(
      "product",
      "{% assign v = product.variants.first %}[{{ v.unit_price | unit_price_with_measurement: v.unit_price_measurement }}|{{ '€1' | unit_price_with_measurement: v.unit_price_measurement }}]",
    ),
    product,
    { snapshot },
  );
  assert.ok(result.html.includes("[USD 1.25/100ml|€1/100ml]"), result.html);
  assert.deepEqual(result.diagnostics, []);
});

test("default_pagination links previous, pages, gaps and next with an optional anchor", async () => {
  const result = await renderTheme(
    theme(
      "collection",
      "{% paginate collection.products by 4 %}{{ paginate | default_pagination: anchor: 'grid', previous: 'Back' }}{% endpaginate %}",
    ),
    "/collections/sop-catalog?page=9",
  );
  const link = (page: number, label: string | number = page) =>
    `<a href="/collections/sop-catalog?page=${page}#grid" title="">${label}</a>`;
  assert.ok(
    result.html.includes(
      [
        `<span class="prev">${link(8, "Back")}</span>`,
        `<span class="page">${link(1)}</span>`,
        '<span class="deco">…</span>',
        `<span class="page">${link(6)}</span>`,
        `<span class="page">${link(7)}</span>`,
        `<span class="page">${link(8)}</span>`,
        '<span class="page current">9</span>',
        `<span class="page">${link(10)}</span>`,
        `<span class="next">${link(10, "Next &raquo;")}</span>`,
      ].join(" "),
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});

test("metafield_tag renders documented element types and reports the rest", async () => {
  const snapshot = defaultFixture();
  const main = snapshot.products[0];
  assert.ok(main);
  main.metafields = {
    custom: {
      line: { type: "single_line_text_field", value: "A & B" },
      flag: { type: "boolean", value: true },
      link: { type: "url", value: "https://example.test/a?b=1&c=2" },
      data: { type: "json", value: { a: "</script>" } },
      cost: { type: "money", value: { amount: "12.50", currency_code: "USD" } },
      list: { type: "list.single_line_text_field", value: ["one", "two"] },
      when: { type: "date", value: "2026-10-13" },
      legacy: "plain",
    },
  };
  const result = await renderTheme(
    theme(
      "product",
      "{% assign m = product.metafields.custom %}{{ m.line | metafield_tag }}|{{ m.flag | metafield_tag }}|{{ m.link | metafield_tag }}|{{ m.data | metafield_tag }}|{{ m.cost | metafield_tag }}|{{ m.list | metafield_tag: list_format: 'ordered' }}|{{ m.when | metafield_tag }}|{{ m.legacy | metafield_tag }}",
    ),
    product,
    { snapshot },
  );
  assert.ok(
    result.html.includes(
      '<span class="metafield-single_line_text_field">A &amp; B</span>|<span class="metafield-boolean">true</span>|<a class="metafield-url" href="https://example.test/a?b=1&amp;c=2">https://example.test/a?b=1&amp;c=2</a>|<script type="application/json" class="metafield-json">{"a":"\\u003c\\/script\\u003e"}</script>|<span class="metafield-money">USD 12.50</span>|<ol class="metafield-single_line_text_field-array"><li class="metafield-single_line_text_field">one</li><li class="metafield-single_line_text_field">two</li></ol>|[not implemented: metafield_tag date]|plain',
    ),
    result.html,
  );
  assert.deepEqual(
    result.diagnostics.map((d) => [d.code, d.message]),
    [
      ["not-implemented", "metafield_tag output for metafield type date is not implemented."],
      [
        "missing-resource",
        "metafield_tag needs a typed snapshot metafield ({type, value}); the plain value is output.",
      ],
    ],
  );
});

test("payment_type_svg_tag uses snapshot SVGs with an optional class and reports missing artwork", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.enabled_payment_types = ["visa", "paypal"];
  snapshot.paymentTypeSvgs = { visa: '<svg viewBox="0 0 38 24"><title>Visa</title></svg>' };
  const result = await renderTheme(
    theme(
      "index",
      "{% for type in shop.enabled_payment_types %}[{{ type | payment_type_svg_tag: class: 'icon' }}]{% endfor %}",
    ),
    "/",
    { snapshot },
  );
  assert.ok(
    result.html.includes('[<svg class="icon" viewBox="0 0 38 24"><title>Visa</title></svg>][]'),
    result.html,
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    ["Local SVG data for payment type paypal is missing."],
  );
});

function mediaSnapshot(): Snapshot {
  const snapshot = defaultFixture();
  const main = snapshot.products[0];
  assert.ok(main);
  main.media = [
    {
      mediaType: "video",
      id: "71",
      alt: "Walkthrough",
      previewImage: preview,
      duration: 4000,
      sources: [
        {
          file: "clip.m3u8",
          format: "m3u8",
          mimeType: "application/x-mpegURL",
          width: 640,
          height: 320,
        },
        { file: "clip.mp4", format: "mp4", mimeType: "video/mp4", width: 640, height: 320 },
      ],
    },
    { mediaType: "image", file: "pattern-01.png" },
    {
      mediaType: "external_video",
      alt: null,
      previewImage: preview,
      host: "youtube",
      externalId: "abc_123",
    },
    {
      mediaType: "model",
      id: "73",
      alt: "Needle",
      previewImage: preview,
      sources: [{ file: "needle.glb", format: "glb", mimeType: "model/gltf-binary" }],
    },
    { mediaType: "image", file: "pattern-02.png" },
  ];
  return snapshot;
}

test("product media list videos, external videos and models in order with documented properties", async () => {
  const result = await renderTheme(
    theme(
      "product",
      "{% for m in product.media %}[{{ m.media_type }}:{{ m.position }}:{{ m.id }}]{% endfor %}|{{ product.featured_media.media_type }}|{% assign v = product.media.first %}{{ v.duration }}:{{ v.aspect_ratio }}:{{ v.sources.last.url }}:{{ v.sources.last.mime_type }}:{{ v.preview_image.id }}|{{ product.media[2].host }}:{{ product.media[2].external_id }}|{{ product.media[3].sources.first.format }}|{{ product.images.size }}",
    ),
    product,
    { snapshot: mediaSnapshot() },
  );
  assert.ok(
    result.html.includes(
      "[video:1:71][image:2:700001][external_video:3:][model:4:73][image:5:700002]|video|4000:2:/sop/images/clip.mp4:video/mp4:|youtube:abc_123|glb|2",
    ),
    result.html,
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    ["Object property external_video.id is absent from the snapshot."],
  );
});

test("media filters render video, external video and model elements from local sources", async () => {
  const result = await renderTheme(
    theme(
      "product",
      "{% for m in product.media %}{% unless m.media_type == 'image' %}{{ m | media_tag: image_size: '200x', autoplay: true }}\n{% endunless %}{% endfor %}{{ product.media[2] | external_video_url: rel: 0 | external_video_tag: class: 'yt' }}",
    ),
    product,
    { snapshot: mediaSnapshot() },
  );
  const lines = result.html.split("\n");
  assert.equal(
    lines[0]?.slice(lines[0].indexOf("<video")),
    '<video playsinline="playsinline" preload="metadata" aria-label="Walkthrough" poster="/sop/images/pattern-03.png?width=200" autoplay="autoplay"><source src="/sop/images/clip.m3u8" type="application/x-mpegURL"><source src="/sop/images/clip.mp4" type="video/mp4"><img src="/sop/images/pattern-03.png?width=200"></video>',
  );
  assert.equal(
    lines[1],
    '<iframe frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen="allowfullscreen" src="https://www.youtube.com/embed/abc_123" title="SOP Matrix Needle" autoplay="autoplay"></iframe>',
  );
  assert.equal(
    lines[2],
    '<model-viewer src="/sop/images/needle.glb" camera-controls="camera-controls" alt="Needle" poster="/sop/images/pattern-03.png?width=200" autoplay="autoplay"></model-viewer>',
  );
  assert.ok(
    lines[3]?.startsWith(
      '<iframe frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen="allowfullscreen" src="https://www.youtube.com/embed/abc_123?rel=0" title="SOP Matrix Needle" class="yt"></iframe>',
    ),
    lines[3],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("media must list each product image exactly once", async () => {
  const snapshot = mediaSnapshot();
  const main = snapshot.products[0];
  assert.ok(main?.media);
  main.media = main.media.filter(
    (entry) => entry.mediaType !== "image" || entry.file !== "pattern-02.png",
  );
  await assert.rejects(renderTheme(theme("product", ""), product, { snapshot }), /each image/);
});

test("liquid settings render in their section scope and video_url settings expose id and type", async () => {
  const result = await renderTheme(
    theme(
      "product",
      `[{{ section.settings.code }}|{{ section.settings.video }}|{{ section.settings.video.id }}|{{ section.settings.video.type }}|{{ section.settings.vimeo.id }}]{% schema %}{"settings":[{"type":"liquid","id":"code","default":"{% if product %}{{ product.title | upcase }}{% endif %}"},{"type":"video_url","id":"video","accept":["youtube"],"default":"https://www.youtube.com/watch?v=_9VUPq3SxOc"},{"type":"video_url","id":"vimeo","accept":["vimeo"],"default":"https://vimeo.com/76979871"}]}{% endschema %}`,
    ),
    product,
  );
  assert.ok(
    result.html.includes(
      "[SOP MATRIX NEEDLE|https://www.youtube.com/watch?v=_9VUPq3SxOc|_9VUPq3SxOc|youtube|76979871]",
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});

test("new_comment forms post to the article's comments and require an article", async () => {
  const result = await renderTheme(
    theme(
      "article",
      "{% form 'new_comment', article %}[{{ form.author }}|{{ form.body }}]{% endform %}",
    ),
    "/blogs/news/story-1",
  );
  assert.ok(
    result.html.includes(
      '<form method="post" action="/blogs/news/story-1/comments#comment_form" id="comment_form" accept-charset="UTF-8" class="comment-form"><input type="hidden" name="form_type" value="new_comment" /><input type="hidden" name="utf8" value="✓" />[|]</form>',
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
  const page = await renderTheme(
    theme("page", "{% form 'new_comment', page %}{% endform %}"),
    "/pages/about",
  );
  assert.ok(
    page.diagnostics.some((d) => d.message.includes("new_comment form requires an article")),
  );
});
