import assert from "node:assert/strict";
import { test } from "node:test";
import { toLiquidHtmlAST } from "@shopify/liquid-html-parser";
import {
  applyOracleNativeImages,
  createOracleNativeImageRecorder,
  extractNativeImagePayload,
  inspectVerifiedNativeImages,
  type NativeImageDependencies,
  type NativeImagePayload,
  prepareNativeImageProbe,
} from "../tools/oracle/image-native.js";
import { applyOracleSeedGenerated } from "../tools/oracle/seed-generated.js";
import { createOracleSeedRuntime } from "../tools/oracle/seed-runtime.js";
import { config, locationId, productLegacy, setup, shopId } from "./helpers/seed-product.js";

// Authored Admin/storefront HTTP mocks only. These are never real store goldens or authorization evidence.
const themeId = "7",
  publication = {
    kind: "Publication" as const,
    id: "gid://shopify/Publication/1",
    catalogId: "gid://shopify/AppCatalog/1",
    appId: "gid://shopify/App/1",
  };
function html(payload: NativeImagePayload) {
  const probe = prepareNativeImageProbe(payload.kind),
    encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `<script id="${probe.key}" type="application/json">${JSON.stringify(encoded)}</script>`;
}
async function seeded() {
  const s = setup(true);
  assert.ok(s.image);
  await s.seedImage();
  await s.ledger.registerEnvironment({ kind: "Location", id: locationId });
  await s.ledger.registerEnvironment(publication);
  const execution = await s.executor.executeVerified(s.step);
  await s.ledger.record(execution);
  const src = `https://${config.domain}/cdn/shop/files/authored.png?v=1`,
    shared = { src, alt: s.image.alt, width: s.image.width, height: s.image.height },
    classicId = "8001",
    mediaId = "8002",
    firstVariant = s.variants[0];
  assert.ok(firstVariant);
  const payload: NativeImagePayload = {
    shopId: "1",
    permanentDomain: config.domain,
    kind: "product",
    parentId: productLegacy,
    handle: s.source.handle,
    images: [
      {
        ...shared,
        id: classicId,
        position: 1,
        productId: productLegacy,
        mediaType: null,
        attached: true,
        variants: [firstVariant.legacyResourceId],
        preview: null,
      },
    ],
    media: [
      {
        ...shared,
        alt: null,
        id: mediaId,
        position: 1,
        productId: null,
        mediaType: "image",
        attached: null,
        variants: null,
        preview: {
          ...shared,
          alt: "Observed preview",
          id: null,
          position: null,
          productId: null,
          mediaType: null,
          attached: null,
          variants: null,
        },
      },
    ],
    variants: s.variants.map((variant, index) => ({
      id: variant.legacyResourceId,
      imageId: index === 0 ? classicId : null,
      mediaId: index === 0 ? mediaId : null,
    })),
  };
  return { s, execution, payload };
}
function observer(test: Awaited<ReturnType<typeof seeded>>, failure = "") {
  const { s, payload } = test,
    probe = prepareNativeImageProbe("product");
  let gets = 0,
    themeReads = 0,
    fileReads = 0;
  const dependencies: NativeImageDependencies = {
    readIdentity: async () => ({
      id: failure === "shop" ? "gid://shopify/Shop/2" : shopId,
      myshopifyDomain: config.domain,
      name: "Authored",
      currencyCode: "USD",
      ianaTimezone: "UTC",
      plan: { partnerDevelopment: true },
      metafield: failure === "marker" ? null : { value: "true" },
    }),
    readTheme: async () => {
      themeReads++;
      return {
        id: `gid://shopify/OnlineStoreTheme/${themeId}`,
        role:
          failure === "live" || (failure === "late-live" && themeReads > 2)
            ? "MAIN"
            : "UNPUBLISHED",
        processing: false,
        processingFailed: false,
      };
    },
    readThemeFiles: async () => {
      fileReads++;
      return failure === "files" || (failure === "late-files" && fileReads > 1)
        ? { ...probe.files, [`sections/${probe.key}.liquid`]: "changed" }
        : probe.files;
    },
    verifyShopSettings: async () => {
      if (failure === "settings") throw new Error("private settings detail");
    },
    fetcher: async (url, init) => {
      gets++;
      const target = new URL(String(url));
      assert.equal(target.hostname, config.domain);
      assert.equal(target.searchParams.get("preview_theme_id"), themeId);
      assert.equal(target.searchParams.get("view"), probe.key);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Cookie"), "authored-private-cookie");
      assert.equal(headers.has("x-shopify-access-token"), false);
      assert.equal(headers.has("Authorization"), false);
      const body = structuredClone(payload),
        classic = body.images[0],
        variant = body.variants[0],
        preview = body.media[0]?.preview;
      assert.ok(classic && variant && preview);
      if (failure === "unstable" && gets === 2) classic.id = "9999";
      if (failure === "source") classic.src = "https://example.invalid/unknown.png";
      if (failure === "variant") variant.mediaId = "9999";
      if (failure === "preview") preview.id = "9999";
      if (failure === "parent") body.parentId = "9999";
      return new Response(failure === "oversize" ? "x".repeat(2 * 1024 * 1024 + 1) : html(body), {
        status: failure === "redirect" ? 302 : 200,
        headers: { "content-type": "text/html" },
      });
    },
  };
  const recorder = createOracleNativeImageRecorder(
    config,
    s.snapshot,
    shopId,
    "authored",
    s.ledger,
    dependencies,
    s.fetcher,
  );
  return { recorder, dependencies, gets: () => gets };
}
test("prepared image probes contain only expressions, parse as Liquid/HTML, and never insert expected identity values", () => {
  for (const kind of ["product", "collection", "article"] as const) {
    const probe = prepareNativeImageProbe(kind);
    assert.equal(Object.keys(probe.files).length, 3);
    for (const [path, body] of Object.entries(probe.files)) {
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      if (path.endsWith(".liquid")) assert.doesNotThrow(() => toLiquidHtmlAST(text));
      else assert.doesNotThrow(() => JSON.parse(text));
      assert.equal(text.includes(productLegacy), false);
    }
  }
});
test("canonical Base64 payload parsing preserves explicit nulls, Unicode, closing-script strings, and rejects duplicates or modified source", async () => {
  const { payload } = await seeded(),
    value = structuredClone(payload),
    first = value.images[0];
  assert.ok(first);
  first.alt = '한글 </script> & "';
  assert.deepEqual(
    extractNativeImagePayload(html(value), prepareNativeImageProbe("product")),
    value,
  );
  assert.throws(() =>
    extractNativeImagePayload(html(value) + html(value), prepareNativeImageProbe("product")),
  );
  const probe = prepareNativeImageProbe("product");
  probe.files[`sections/${probe.key}.liquid`] += "changed";
  assert.throws(() => extractNativeImagePayload(html(value), probe));
});
test("owned source, exact unpublished probe, settings and stable Native/API brackets precede source-scoped image ID projection", async () => {
  const fixture = await seeded(),
    test = observer(fixture),
    before = fixture.s.writes(),
    receipt = await test.recorder.observe(
      fixture.s.state.hash,
      fixture.s.task.key,
      themeId,
      "authored-private-cookie",
    );
  assert.equal(test.gets(), 2);
  assert.equal(fixture.s.writes(), before);
  const view = inspectVerifiedNativeImages(receipt);
  assert.equal(view.payload.images[0]?.id, "8001");
  assert.equal(view.payload.media[0]?.id, "8002");
  // Neither number is guessed from the API MediaImage/55 identity.
  const request = fixture.s.plan.requests.find(
    (request) => request.stateHash === fixture.s.state.hash,
  );
  assert.ok(request);
  const generated = await fixture.s.recorder.record(fixture.execution),
    derived = applyOracleSeedGenerated(config, fixture.s.snapshot, shopId, request.caseId, [
      generated,
    ]),
    projected = applyOracleNativeImages(
      config,
      fixture.s.snapshot,
      shopId,
      request.caseId,
      derived.snapshot,
      [receipt],
    ),
    image = projected.snapshot.products[0]?.images[0];
  assert.equal(image?.id, "8001");
  assert.equal(image?.mediaId, "8002");
  assert.equal(image?.mediaAlt, null);
  assert.equal(image?.previewAlt, "Observed preview");
  assert.equal(derived.snapshot.products[0]?.images[0]?.id, undefined);
  assert.equal(projected.captureReady, false);
  for (const field of ["parent", "variant"] as const) {
    const changed = structuredClone(derived.snapshot),
      product = changed.products[0];
    assert.ok(product && product.variants[0]);
    if (field === "parent") product.id = "9999";
    else product.variants[0].id = "9999";
    assert.throws(
      () =>
        applyOracleNativeImages(config, fixture.s.snapshot, shopId, request.caseId, changed, [
          receipt,
        ]),
      { code: "source-mismatch" },
    );
  }
  assert.throws(() => inspectVerifiedNativeImages(JSON.parse(JSON.stringify(receipt))), {
    code: "unverified-observation",
  });
  assert.throws(
    () =>
      applyOracleNativeImages(
        config,
        fixture.s.snapshot,
        shopId,
        request.caseId,
        derived.snapshot,
        [receipt, receipt],
      ),
    { code: "scope-mismatch" },
  );
});
test("wrong shop, missing marker, live theme, changed files or failed settings prevent Native GETs", async () => {
  const fixture = await seeded();
  for (const failure of ["shop", "marker", "live", "files", "settings"]) {
    const test = observer(fixture, failure);
    await assert.rejects(
      test.recorder.observe(
        fixture.s.state.hash,
        fixture.s.task.key,
        themeId,
        "authored-private-cookie",
      ),
    );
    assert.equal(test.gets(), 0);
  }
});
test("the composed runtime uses its private owned ledger and pins caller input before Native observation", async () => {
  const fixture = await seeded(),
    s = fixture.s,
    configInput = { ...config },
    snapshotInput = structuredClone(s.snapshot),
    runtime = createOracleSeedRuntime(
      configInput,
      snapshotInput,
      shopId,
      "authored",
      s.retained,
      s.assets,
      {
        authorize: async () => {},
        fetcher: s.fetcher,
        uploadFetcher: async () => new Response(null, { status: 204 }),
      },
    );
  // Mutating a caller's object must not change future recorder construction or token destinations.
  configInput.domain = "changed.invalid";
  snapshotInput.products = [];
  await runtime.registerEnvironment({ kind: "Location", id: locationId });
  await runtime.registerEnvironment(publication);
  const imageTask = s.state.tasks.find(
    (task) => task.resource === "image" && task.identity[0] === s.image?.file,
  );
  assert.ok(imageTask && s.image);
  const base = {
      ...s.step,
      taskKey: imageTask.key,
      options: { mode: "create" as const, imageBytes: s.imageBytes.length },
      bindings: {},
    },
    staged = await runtime.execute(base);
  await runtime.upload(staged, s.imageBytes);
  const stagedKey = JSON.stringify(["staged-image-url", s.image.file]);
  await runtime.execute({
    ...base,
    requestIndex: 1,
    bindings: { [stagedKey]: runtime.getBinding(stagedKey) },
  });
  await runtime.execute(s.step);
  const test = observer(fixture),
    before = s.writes();
  let release: () => void = () => {},
    entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const observed = runtime.observeNativeImages(
    s.state.hash,
    s.task.key,
    themeId,
    "authored-private-cookie",
    {
      ...test.dependencies,
      verifyShopSettings: async () => {
        entered();
        await hold;
      },
    },
  );
  await ready;
  await assert.rejects(runtime.verifyStore(), { code: "concurrent-operation" });
  release();
  const receipt = await observed;
  assert.equal(inspectVerifiedNativeImages(receipt).payload.images[0]?.id, "8001");
  assert.equal(test.gets(), 2);
  assert.equal(s.writes(), before);
});
test("late file/theme drift, unstable payload, wrong source/variant/preview identity and redirects issue no Native receipt", async () => {
  const fixture = await seeded(),
    writes = fixture.s.writes();
  for (const failure of [
    "late-files",
    "late-live",
    "unstable",
    "source",
    "variant",
    "preview",
    "parent",
    "oversize",
    "redirect",
  ]) {
    const test = observer(fixture, failure);
    await assert.rejects(
      test.recorder.observe(
        fixture.s.state.hash,
        fixture.s.task.key,
        themeId,
        "authored-private-cookie",
      ),
    );
  }
  assert.equal(fixture.s.writes(), writes);
});
