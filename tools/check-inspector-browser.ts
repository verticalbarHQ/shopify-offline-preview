import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import type { RenderNode } from "../packages/render/src/contracts.js";
import { renderTheme } from "../packages/render/src/index.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";
import { BrowserProtocol } from "./browser/cdp.js";

const origins = process.argv.slice(2);
if (
  origins.length !== 2 ||
  origins.some((origin) => {
    const url = new URL(origin);
    return url.protocol !== "http:" || url.hostname !== "127.0.0.1";
  })
)
  throw new Error("Provide Dawn and Horizon loopback inspector origins");
const session = "sop-inspector-e2e";
const browser = (...args: string[]) =>
  execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
browser("open", `${origins[0]}/`);
const client = await BrowserProtocol.connect(browser("get", "cdp-url").trim());
const targets = z
  .object({
    targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
  })
  .parse(await client.call("Target.getTargets"));
const target = targets.targetInfos.find(
  (item) => item.type === "page" && item.url.startsWith(origins[0] ?? ""),
);
assert.ok(target);
const attached = z
  .object({ sessionId: z.string() })
  .parse(await client.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
const contexts = new Map<string, number>();
client.on((event) => {
  if (event.sessionId !== attached.sessionId) return;
  if (event.method === "Runtime.executionContextCreated") {
    const context = z
      .object({
        context: z.object({
          id: z.number(),
          auxData: z.object({ frameId: z.string(), isDefault: z.boolean() }).optional(),
        }),
      })
      .parse(event.params).context;
    if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
  }
  if (event.method === "Runtime.executionContextDestroyed") {
    const { executionContextId } = z.object({ executionContextId: z.number() }).parse(event.params);
    for (const [frameId, contextId] of contexts)
      if (contextId === executionContextId) contexts.delete(frameId);
  }
  if (event.method === "Runtime.executionContextsCleared") contexts.clear();
});
await client.call("Runtime.enable", {}, attached.sessionId);
await client.call("Page.enable", {}, attached.sessionId);
const manifest = z
  .array(z.object({ name: z.string(), path: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
const rows = [];
function flatten(nodes: RenderNode[]): RenderNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}
/** Evaluates in the preview frame at `previewUrl` once it returns a non-null value. */
async function inPreview(previewUrl: string, expression: string): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frames = z
      .object({
        frameTree: z.object({
          childFrames: z
            .array(z.object({ frame: z.object({ id: z.string(), url: z.string() }) }))
            .optional(),
        }),
      })
      .parse(await client.call("Page.getFrameTree", {}, attached.sessionId));
    const frameId = frames.frameTree.childFrames?.find((frame) => frame.frame.url === previewUrl)
      ?.frame.id;
    const frameContext = frameId ? contexts.get(frameId) : undefined;
    if (frameContext !== undefined) {
      try {
        const value = await client.evaluate(attached.sessionId, expression, frameContext);
        if (value !== null) return value;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/Cannot find context|Execution context was destroyed/.test(error.message)
        )
          throw error;
      }
    }
    await delay(50);
  }
  return null;
}
const wait = `async predicate => {const until=Date.now()+10000;while(!predicate()){if(Date.now()>until) throw new Error('Inspector did not become ready');await new Promise(resolve=>setTimeout(resolve,20));}}`;
try {
  for (const [index, item] of manifest.entries()) {
    const origin = origins[index];
    const navigation = z
      .object({ loaderId: z.string() })
      .parse(await client.call("Page.navigate", { url: `${origin}/` }, attached.sessionId));
    let parentReady = false;
    // A late load event from the previous page can arrive after navigation starts.
    // Match the navigation loader before readiness, even for a same-origin reload.
    // Retry only destroyed navigation contexts.
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const document = z
          .object({ frameTree: z.object({ frame: z.object({ loaderId: z.string() }) }) })
          .parse(await client.call("Page.getFrameTree", {}, attached.sessionId));
        if (document.frameTree.frame.loaderId !== navigation.loaderId) {
          await delay(50);
          continue;
        }
        parentReady =
          (await client.evaluate(
            attached.sessionId,
            `location.origin===${JSON.stringify(origin)} && !!window.SOP_INSPECTOR_STATE?.result && document.querySelector('#status')?.dataset.state==='ready'`,
          )) === true;
        if (parentReady) break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/Cannot find context|Execution context was destroyed/.test(error.message)
        )
          throw error;
      }
      await delay(50);
    }
    assert.ok(parentReady, `${item.name}: inspector document did not become ready`);
    for (const page of benchmarkMatrix) {
      const expected = await renderTheme(new NodeThemeFileSystem(item.path), page.path, {
        snapshot: defaultFixture(),
        scenario: page.scenario,
        inspect: true,
      });
      const expectedHash = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
      const actual = z
        .object({
          hash: z.string(),
          nodes: z.number(),
          sourceNodes: z.array(z.object({ id: z.string(), kind: z.string(), file: z.string() })),
          coreDiagnostics: z.number(),
          iframeIsolated: z.boolean(),
          previewUrl: z.string().url(),
        })
        .parse(
          await client.evaluate(
            attached.sessionId,
            `(async()=>{
      document.querySelector('#path').value=${JSON.stringify(page.path)};document.querySelector('#scenario').value=${JSON.stringify(page.scenario)};document.querySelector('#controls').requestSubmit();
      await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');
      const result=window.SOP_INSPECTOR_STATE.result;
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(result))))].map(b=>b.toString(16).padStart(2,'0')).join('');
      return {hash,nodes:document.querySelectorAll('.tree-node').length,sourceNodes:[...document.querySelectorAll('.tree-node')].map(node=>({id:node.dataset.nodeId,kind:node.dataset.kind,file:node.dataset.file})),coreDiagnostics:document.querySelectorAll('#diagnostics .diagnostic').length,iframeIsolated:document.querySelector('#preview').contentDocument===null,previewUrl:document.querySelector('#preview').src};})()`,
          ),
        );
      assert.equal(actual.hash, expectedHash, `${item.name}/${page.id}: CLI/core contract differs`);
      assert.equal(actual.coreDiagnostics, expected.diagnostics.length);
      const nodes = flatten(expected.tree);
      assert.deepEqual(
        actual.sourceNodes,
        nodes.map(({ id, kind, file }) => ({ id, kind, file })),
        `${item.name}/${page.id}: visible source tree differs`,
      );
      const files = new Set(await new NodeThemeFileSystem(item.path).listFiles());
      for (const node of nodes)
        assert.ok(
          files.has(node.file),
          `${item.name}/${page.id}: source file absent for ${node.id}`,
        );
      assert.equal(actual.iframeIsolated, true);
      const previewUrl = new URL(actual.previewUrl);
      const viewId = previewUrl.searchParams.get("__sop_view");
      assert.ok(viewId, `${item.name}/${page.id}: preview view ID absent`);
      assert.equal(previewUrl.searchParams.get("__sop_route"), page.path);
      assert.equal(previewUrl.searchParams.get("__sop_scenario"), page.scenario);
      const childSchema = z.object({
        regions: z.number(),
        badges: z.number(),
        path: z.string(),
        viewId: z.string(),
      });
      // The parent is ready before iframe navigation finishes. Read the bridge and
      // measurements atomically from this generation, never from a prior same-route view.
      const observation = await inPreview(
        actual.previewUrl,
        `(()=>{if(location.href!==${JSON.stringify(actual.previewUrl)})return null;const element=document.getElementById('sop-bridge-config');const badges=document.getElementById('sop-diagnostic-badges');if(!element||!badges)return null;const config=JSON.parse(element.textContent);return {regions:config.regions.filter(region=>document.getElementById(region.domId)).length,badges:badges.children.length,path:config.path,viewId:config.viewId};})()`,
      );
      const child = observation === null ? undefined : childSchema.parse(observation);
      assert.ok(child, `${item.name}/${page.id}: current iframe bridge absent`);
      assert.equal(child.viewId, viewId, `${item.name}/${page.id}: stale preview view`);
      assert.equal(child.path, page.path, `${item.name}/${page.id}: preview route changed`);
      rows.push({
        theme: item.name,
        case: page.id,
        treeNodes: actual.nodes,
        diagnostics: actual.coreDiagnostics,
        highlightRegions: child.regions,
        badges: child.badges,
        contractEqual: true,
        originsIsolated: true,
      });
      console.log(
        `${item.name}/${page.id}: ${actual.nodes} source nodes; ${child.regions} regions; CLI diagnostics equal`,
      );
    }
    // The theme's own add-to-cart script must reach the blocked-endpoint contract through
    // routes.cart_add_url (Dawn posts to it; Horizon appends `.js`).
    const previewUrl = z
      .string()
      .url()
      .parse(
        await client.evaluate(
          attached.sessionId,
          `(async()=>{document.querySelector('#path').value='/products/sop-matrix-needle';document.querySelector('#scenario').value='default';document.querySelector('#controls').requestSubmit();await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');window.SOP_INSPECTOR_STATE.runtime=[];return document.querySelector('#preview').src;})()`,
        ),
      );
    const clicked = await inPreview(
      previewUrl,
      `(()=>{if(location.href!==${JSON.stringify(previewUrl)}||!document.getElementById('sop-diagnostic-badges'))return null;const button=document.querySelector('form[action="/cart/add"] button[type=submit]');if(!button||button.disabled)return 'unavailable';button.click();return 'clicked';})()`,
    );
    assert.equal(clicked, "clicked", `${item.name}: product form submit button`);
    const blocked = await client.evaluate(
      attached.sessionId,
      `(async()=>{await (${wait})(()=>window.SOP_INSPECTOR_STATE.runtime.some(d=>d.code==='blocked-endpoint'));return window.SOP_INSPECTOR_STATE.runtime.filter(d=>d.code==='blocked-endpoint').map(d=>d.message);})()`,
    );
    const messages = z.array(z.string()).parse(blocked);
    assert.ok(
      messages.some((message) => /^\/cart\/add(?:\.js)?: /.test(message)),
      `${item.name}: add to cart did not report a blocked cart endpoint: ${messages.join("; ")}`,
    );
    rows.push({ theme: item.name, case: "add-to-cart", blockedEndpoints: messages });
    console.log(`${item.name}/add-to-cart: ${messages.join("; ")}`);
  }
  await writeFile(
    ".local/results/inspector-browser-summary.json",
    `${JSON.stringify(
      {
        status: "pass",
        scope: "Full offline inspector matrix; Shopify parity remains pending",
        rows,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  client.close();
  browser("close");
}
