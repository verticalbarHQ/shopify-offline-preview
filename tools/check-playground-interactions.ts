import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { BrowserProtocol } from "./browser/cdp.js";

await mkdir(".local/results", { recursive: true });
const root = resolve("dist/playground"),
  temp = await mkdtemp(join(tmpdir(), "sop-playground-interactions-"));
const files = {
  "layout/theme.liquid":
    '<!doctype html><html><head><script type="module" src="/sop/assets/a.js"></script><link rel="stylesheet" href="/sop/assets/main.css"></head><body>{{content_for_layout}}</body></html>',
  "templates/index.json":
    '{"sections":{"main":{"type":"main","settings":{"featured":"absent"}}},"order":["main"]}',
  "sections/main.liquid":
    '<h1>{{shop.name}}</h1>{% content_for \'block\', type: \'label\', id: \'label\', label: shop.name %}<p id="mode">{{request.design_mode}}</p><a id="navigate" href="/pages/about">About</a>{% schema %}{"settings":[{"type":"product","id":"featured"}]}{% endschema %}',
  "blocks/label.liquid":
    '<p id="theme-block">Block: {{label}}</p>{% schema %}{"tag":null}{% endschema %}',
  "templates/page.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "assets/a.js":
    'import {answer} from "./b.js"; export const marker=17; window.moduleAnswer=answer; import("./b.js").then(m=>window.dynamicAnswer=m.answer);',
  "assets/b.js":
    'import {marker} from "./a.js"; export const answer=37; export function readMarker(){return marker;}',
  "assets/main.css": '@import "./base.css";',
  "assets/base.css": "h1{color:rgb(150,0,0)}",
};
const themeZip = join(temp, "theme.zip");
await writeFile(
  themeZip,
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
);
const snapshot = defaultFixture();
snapshot.shop.name = "Private Browser Snapshot Needle";
const dataFiles: Record<string, Uint8Array> = {
  "snapshot.json": strToU8(JSON.stringify(snapshot)),
};
for (const file of new Set(snapshot.products.flatMap((p) => p.images.map((i) => i.file))))
  dataFiles[`images/${file}`] = await readFile(`fixtures/default/images/${file}`);
const dataZip = join(temp, "snapshot.zip");
await writeFile(dataZip, zipSync(dataFiles));
const server = createServer((request, response) => {
  void (async () => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = resolve(join(root, path === "/" ? "index.html" : path));
      assert.ok(file.startsWith(`${root}/`));
      response.writeHead(200, {
        "Content-Type":
          (
            { ".html": "text/html", ".js": "text/javascript", ".png": "image/png" } as Record<
              string,
              string
            >
          )[extname(file)] ?? "application/octet-stream",
      });
      response.end(await readFile(file));
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
const name = "sop-playground-interactions";
const execute = promisify(execFile);
const browser = async (...args: string[]) =>
  (
    await execute("agent-browser", ["--session", name, ...args], {
      encoding: "utf8",
      timeout: 15000,
    })
  ).stdout;
let client: BrowserProtocol | undefined;
try {
  await browser("open", origin);
  const c = await BrowserProtocol.connect((await browser("get", "cdp-url")).trim());
  client = c;
  const targets = z
    .object({
      targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
    })
    .parse(await c.call("Target.getTargets"));
  const target = targets.targetInfos.find((t) => t.type === "page" && t.url.startsWith(origin));
  assert.ok(target);
  const { sessionId } = z
    .object({ sessionId: z.string() })
    .parse(await c.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
  const requests: { url: string; method: string; sessionId: string }[] = [];
  const frameSessions = new Map<string, string>();
  c.on((event) => {
    if (event.method === "Network.requestWillBeSent") {
      const p = z
        .object({ request: z.object({ url: z.string(), method: z.string() }) })
        .parse(event.params);
      requests.push({ ...p.request, sessionId: event.sessionId ?? "" });
    }
    if (event.method === "Target.attachedToTarget") {
      const p = z
        .object({
          sessionId: z.string(),
          targetInfo: z.object({ targetId: z.string(), type: z.string() }),
          waitingForDebugger: z.boolean(),
        })
        .parse(event.params);
      if (p.targetInfo.type === "iframe") {
        frameSessions.set(p.targetInfo.targetId, p.sessionId);
        void c
          .call("Network.enable", {}, p.sessionId)
          .then(() =>
            p.waitingForDebugger
              ? c.call("Runtime.runIfWaitingForDebugger", {}, p.sessionId)
              : undefined,
          );
      }
    }
  });
  await c.call("Network.enable", {}, sessionId);
  await c.call("Page.enable", {}, sessionId);
  await c.call(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    sessionId,
  );
  const wait = `async predicate=>{const until=Date.now()+10000;while(!predicate()){if(Date.now()>until)throw new Error('Interaction timed out: '+document.querySelector('#status')?.textContent);await new Promise(r=>setTimeout(r,20));}}`;
  const parent = (code: string) => c.evaluate(sessionId, code);
  await browser("upload", "#theme-zip", themeZip);
  await parent(
    `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  async function frame(code: string) {
    for (let i = 0; i < 50; i++) {
      const all = z
        .object({
          targetInfos: z.array(
            z.object({ targetId: z.string(), type: z.string(), url: z.string() }),
          ),
        })
        .parse(await c.call("Target.getTargets"));
      const target = all.targetInfos.find((t) => t.type === "iframe" && t.url === "about:srcdoc");
      const sid = target && frameSessions.get(target.targetId);
      if (sid)
        try {
          return await c.evaluate(sid, code);
        } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Opaque preview frame is unavailable");
  }
  assert.deepEqual(
    await frame(
      `(async()=>{await (${wait})(()=>window.moduleAnswer===37&&window.dynamicAnswer===37);let parentBlocked=false;try{void parent.document.body}catch{parentBlocked=true}return {module:window.moduleAnswer,dynamic:window.dynamicAnswer,color:getComputedStyle(document.querySelector('h1')).color,parentBlocked};})()`,
    ),
    { module: 37, dynamic: 37, color: "rgb(150, 0, 0)", parentBlocked: true },
  );
  assert.deepEqual(
    await frame(
      `fetch('/cart/add.js',{method:'POST'}).then(async response=>({status:response.status,body:await response.json()}))`,
    ),
    { status: 501, body: { error: "not available offline" } },
  );
  assert.deepEqual(
    await frame(
      `new Promise(resolve=>{const x=new XMLHttpRequest();x.open('POST','/cart/add.js');x.onload=()=>resolve({status:x.status,body:JSON.parse(x.responseText)});x.send('example');})`,
    ),
    { status: 501, body: { error: "not available offline" } },
  );
  await parent(
    `(async()=>{await (${wait})(()=>document.querySelector('#runtime [data-code="blocked-endpoint"]'));document.querySelector('#device').value='390';document.querySelector('#device').dispatchEvent(new Event('change'));document.querySelector('.tree-node[data-kind="section"]').click();await (${wait})(()=>document.querySelector('#source').textContent.includes('{{shop.name}}'));return true;})()`,
  );
  assert.equal(
    await parent("document.querySelector('#preview').getBoundingClientRect().width"),
    390,
  );
  await parent(
    "document.querySelector('.tree-node[data-kind=section]').dispatchEvent(new MouseEvent('mouseenter'));true;",
  );
  assert.equal(
    await frame(
      `(async()=>{await (${wait})(()=>document.querySelector('#sop-region-highlight').style.display==='block');return true;})()`,
    ),
    true,
  );
  await parent(
    "document.querySelector('[data-kind=block]').dispatchEvent(new MouseEvent('mouseenter'));true",
  );
  assert.equal(
    await frame(
      `(async()=>{await (${wait})(()=>{const r=document.querySelector('#theme-block').getBoundingClientRect(),o=document.querySelector('#sop-region-highlight').getBoundingClientRect();return document.querySelector('#sop-region-highlight').style.display==='block'&&o.width>0&&Math.abs(o.top-r.top)<2&&o.height<=r.height+2;});return true;})()`,
    ),
    true,
  );
  await frame(
    "(()=>{const element=document.querySelector('#theme-block'),r=element.getBoundingClientRect();element.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:r.left+2,clientY:r.top+2}));return true;})()",
  );
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>document.querySelector('[data-kind=block]').getAttribute('aria-pressed')==='true'&&document.querySelector('#source').textContent.includes('{{label}}'));return true;})()`,
    ),
    true,
  );
  await browser("upload", "#snapshot-zip", dataZip);
  await parent(
    `(async()=>{await (${wait})(()=>window.SOP_INSPECTOR_STATE.result?.html.includes('Private Browser Snapshot Needle')&&document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  await parent(
    `document.querySelector('#design').checked=true;document.querySelector('#design').dispatchEvent(new Event('change'));true;`,
  );
  await parent(
    `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  assert.equal(
    await frame(
      `(async()=>{await (${wait})(()=>document.querySelector('#mode')?.textContent==='true');return window.Shopify.designMode;})()`,
    ),
    true,
  );
  const invalidZip = join(temp, "invalid-snapshot.zip");
  await writeFile(invalidZip, zipSync({ "snapshot.json": strToU8('{"invalid":true}') }));
  await browser("upload", "#snapshot-zip", invalidZip);
  await parent(
    `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='error'&&window.SOP_INSPECTOR_STATE.result===null);return true;})()`,
  );
  assert.equal(await parent("document.querySelector('#preview').getAttribute('srcdoc')"), "");
  await parent("document.querySelector('#default-snapshot').click();true;");
  await parent(
    `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  const slowZip = join(temp, "slow-snapshot.zip");
  const slow = structuredClone(snapshot);
  slow.shop.name = "Stale Snapshot Must Not Appear";
  await writeFile(
    slowZip,
    zipSync({ ...dataFiles, "snapshot.json": strToU8(JSON.stringify(slow)) }),
  );
  await parent(
    `(()=>{const original=File.prototype.arrayBuffer;window.__sopOriginalFileRead=original;File.prototype.arrayBuffer=function(){if(this.name==='slow-snapshot.zip'){window.__sopSlowReadStarted=true;return new Promise(resolve=>setTimeout(resolve,400)).then(()=>original.call(this));}return original.call(this);};return true;})()`,
  );
  await browser("upload", "#snapshot-zip", slowZip);
  await parent(
    `(async()=>{await (${wait})(()=>window.__sopSlowReadStarted);document.querySelector('#default-snapshot').click();await new Promise(r=>setTimeout(r,650));File.prototype.arrayBuffer=window.__sopOriginalFileRead;return true;})()`,
  );
  assert.equal(
    await parent(
      "window.SOP_INSPECTOR_STATE.result.html.includes('Stale Snapshot Must Not Appear')",
    ),
    false,
  );
  assert.equal(
    await parent("window.SOP_INSPECTOR_STATE.result.html.includes('Offline Example Shop')"),
    true,
  );
  // Exercise genuine browser directory handles through Origin Private File System; the OS picker dialog is outside this test.
  await parent(
    `(async()=>{const root=await navigator.storage.getDirectory();const theme=await root.getDirectoryHandle('sop-test-theme',{create:true});for(const [path,text] of Object.entries(${JSON.stringify(files)})){const parts=path.split('/');const name=parts.pop();let dir=theme;for(const part of parts)dir=await dir.getDirectoryHandle(part,{create:true});const file=await dir.getFileHandle(name,{create:true});const writer=await file.createWritable();await writer.write(text);await writer.close();}window.showDirectoryPicker=async function(){'use strict';if(this!==window)throw new Error('Folder picker receiver was lost');return theme;};document.querySelector('#open-theme-folder').click();await (${wait})(()=>!document.querySelector('#reload-folder').disabled&&document.querySelector('#status').dataset.state==='ready');const sections=await theme.getDirectoryHandle('sections');const file=await sections.getFileHandle('main.liquid');const writer=await file.createWritable();await writer.write('<h1>Folder Reload Needle</h1>');await writer.close();document.querySelector('#reload-folder').click();await (${wait})(()=>window.SOP_INSPECTOR_STATE.result?.html.includes('Folder Reload Needle')&&document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  for (const request of requests.filter((r) => r.sessionId === sessionId)) {
    const url = new URL(request.url);
    if (["data:", "blob:"].includes(url.protocol)) continue;
    assert.equal(url.origin, origin);
    assert.equal(request.method, "GET");
    assert.ok(!url.href.includes("Needle"));
  }
  const report = {
    status: "pass",
    zipInput: true,
    snapshotInput: true,
    nativeDirectoryHandleReload: true,
    osPickerDialog: "not automated",
    opaqueIframe: true,
    parentAccessBlocked: true,
    moduleCycles: true,
    dynamicImports: true,
    cssImports: true,
    sourceViewer: true,
    sectionHighlight: true,
    themeBlockRangeHighlight: true,
    themeBlockHoverAndSource: true,
    mobileWidth: 390,
    fetchAndXhr501: true,
    designMode: true,
    noUploads: true,
    invalidSnapshotClearsPreview: true,
    folderPickerReceiverPreserved: true,
    latestSnapshotSelectionWins: true,
  };
  await writeFile(
    ".local/results/playground-interactions.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
} finally {
  client?.close();
  await browser("close").catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
