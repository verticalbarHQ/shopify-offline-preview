import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { zipSync } from "fflate";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";
import { BrowserProtocol } from "./browser/cdp.js";

await mkdir(".local/results", { recursive: true });
const root = resolve("dist/playground");
const temp = await mkdtemp(join(tmpdir(), "sop-playground-e2e-"));
const server = createServer((request, response) => {
  void (async () => {
    try {
      assert.equal(request.method, "GET");
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = resolve(join(root, pathname === "/" ? "index.html" : pathname));
      assert.ok(file.startsWith(`${root}/`));
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type":
          (
            { ".html": "text/html", ".js": "text/javascript", ".png": "image/png" } as Record<
              string,
              string
            >
          )[extname(file)] ?? "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  })();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const name = "sop-playground-matrix";
const run = promisify(execFile);
const browser = async (...args: string[]) =>
  (await run("agent-browser", ["--session", name, ...args], { encoding: "utf8", timeout: 15000 }))
    .stdout;
let client: BrowserProtocol | undefined;
const rows = [];
const requests: { url: string; method: string; body: string; sessionId: string }[] = [];
try {
  await browser("open", origin);
  client = await BrowserProtocol.connect((await browser("get", "cdp-url")).trim());
  const c = client;
  const targets = z
    .object({
      targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
    })
    .parse(await c.call("Target.getTargets"));
  const page = targets.targetInfos.find((t) => t.type === "page" && t.url.startsWith(origin));
  assert.ok(page);
  const { sessionId } = z
    .object({ sessionId: z.string() })
    .parse(await c.call("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
  c.on((event) => {
    if (event.method === "Network.requestWillBeSent") {
      const data = z
        .object({
          request: z.object({
            url: z.string(),
            method: z.string(),
            postData: z.string().optional(),
          }),
        })
        .parse(event.params);
      requests.push({
        ...data.request,
        body: data.request.postData ?? "",
        sessionId: event.sessionId ?? "",
      });
    }
    if (event.method === "Target.attachedToTarget") {
      const attached = z
        .object({
          sessionId: z.string(),
          targetInfo: z.object({ type: z.string() }),
          waitingForDebugger: z.boolean(),
        })
        .parse(event.params);
      if (attached.targetInfo.type === "iframe")
        void c
          .call("Network.enable", {}, attached.sessionId)
          .then(() =>
            attached.waitingForDebugger
              ? c.call("Runtime.runIfWaitingForDebugger", {}, attached.sessionId)
              : undefined,
          );
    }
  });
  await c.call("Network.enable", {}, sessionId);
  await c.call("Page.enable", {}, sessionId);
  await c.call(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  );
  await c.call("Page.navigate", { url: origin }, sessionId);
  await c.evaluate(
    sessionId,
    `(async()=>{const until=Date.now()+10000;while(!document.querySelector('#input-status')?.textContent.includes('Open a theme')){if(Date.now()>until)throw new Error('Playground did not initialize');await new Promise(r=>setTimeout(r,20));}return true;})()`,
  );
  const wait = `async predicate=>{const until=Date.now()+10000;while(!predicate()){if(Date.now()>until)throw new Error('Playground not ready: '+document.querySelector('#status')?.textContent);await new Promise(r=>setTimeout(r,20));}}`;
  const manifest = z
    .array(z.object({ name: z.string(), path: z.string(), commit: z.string() }))
    .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
  for (const item of manifest) {
    const theme = new NodeThemeFileSystem(item.path);
    const files: Record<string, Uint8Array> = {};
    for (const file of await theme.listFiles()) files[file] = await theme.readBytes(file);
    const zip = join(temp, `${item.name}.zip`);
    await writeFile(zip, zipSync(files));
    await browser("upload", "#theme-zip", zip);
    await c.evaluate(
      sessionId,
      `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='ready' && document.querySelector('#input-status').textContent.startsWith(${JSON.stringify(`${Object.keys(files).length} theme files`)}));return true;})()`,
    );
    for (const entry of benchmarkMatrix) {
      const expected = await renderTheme(theme, entry.path, {
        snapshot: defaultFixture(),
        scenario: entry.scenario,
        inspect: true,
      });
      const expectedHash = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
      const result = z
        .object({
          hash: z.string(),
          nodes: z.number(),
          diagnostics: z.number(),
          isolated: z.boolean(),
        })
        .parse(
          await c.evaluate(
            sessionId,
            `(async()=>{
    document.querySelector('#path').value=${JSON.stringify(entry.path)};document.querySelector('#scenario').value=${JSON.stringify(entry.scenario)};document.querySelector('#controls').requestSubmit();
    await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');
    const result=window.SOP_INSPECTOR_STATE.result;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(result))))].map(b=>b.toString(16).padStart(2,'0')).join('');
    return {hash,nodes:document.querySelectorAll('.tree-node').length,diagnostics:document.querySelectorAll('#diagnostics .diagnostic').length,isolated:document.querySelector('#preview').contentDocument===null};})()`,
          ),
        );
      assert.equal(result.hash, expectedHash, `${item.name}/${entry.id} core result`);
      assert.equal(result.diagnostics, expected.diagnostics.length);
      assert.equal(result.isolated, true);
      const count = (nodes: typeof expected.tree): number =>
        nodes.reduce((n, node) => n + 1 + count(node.children), 0);
      assert.equal(result.nodes, count(expected.tree));
      rows.push({
        theme: item.name,
        commit: item.commit,
        case: entry.id,
        coreEqualsNode: true,
        treeEqualsCore: true,
        opaqueIframe: true,
      });
      console.log(`${item.name}/${entry.id}: core, tree, diagnostics, isolation PASS`);
    }
  }
  const parentRequests = requests.filter((r) => r.sessionId === sessionId);
  for (const request of parentRequests) {
    const url = new URL(request.url);
    if (["data:", "blob:"].includes(url.protocol)) continue;
    assert.equal(url.origin, origin, "Playground initiated a non-static request");
    assert.equal(request.method, "GET");
    assert.equal(request.body, "");
    assert.ok(!/[{}]|%7B|%7D|%7b|%7d/.test(url.href), "Theme content appeared in a URL");
  }
  assert.ok(rows.length === 36);
  const report = {
    status: "pass",
    coverage: "Current renderer only; Shopify parity remains pending",
    rows,
    parentRequests: parentRequests.length,
    noUploads: true,
    themeRequests: requests.filter((r) => r.sessionId !== sessionId).length,
  };
  await writeFile(
    ".local/results/playground-browser-summary.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      status: report.status,
      cases: rows.length,
      noUploads: true,
      parentRequests: parentRequests.length,
    }),
  );
} finally {
  client?.close();
  await browser("close").catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
