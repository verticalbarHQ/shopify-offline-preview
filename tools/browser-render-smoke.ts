import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";

// Local test harness only. Theme source remains outside the repo and is served on loopback.
const manifest = z
  .array(z.object({ name: z.string(), path: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
const themes = [];
for (const item of manifest) {
  const fs = new NodeThemeFileSystem(item.path);
  const files: Record<string, string> = {};
  for (const file of await fs.listFiles())
    if (
      /^(?:layout|templates|sections|blocks|snippets|config|locales)\//.test(file) &&
      /\.(?:liquid|json)$/.test(file)
    )
      files[file] = await fs.readText(file);
  const cases = [];
  for (const page of benchmarkMatrix) {
    const result = await renderTheme(fs, page.path, {
      snapshot: defaultFixture(),
      scenario: page.scenario,
      inspect: true,
    });
    cases.push({
      ...page,
      expected: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    });
  }
  themes.push({ name: item.name, files, cases });
}
const payload = JSON.stringify({ snapshot: defaultFixture(), themes });
const bundle = await readFile("dist/browser.js");
const html = `<!doctype html><html lang="en"><title>Offline renderer verification</title><link rel="icon" href="data:,"><h1>Offline renderer verification</h1><p id="status">Running initial assembly comparisons…</p><script type="module">
import {renderTheme,MemoryThemeFileSystem} from '/bundle.js';
try {
 const {snapshot,themes}=await (await fetch('/cases.json')).json();
 const before=performance.getEntriesByType('resource').length;
 const rows=[];
 for(const theme of themes) for(const item of theme.cases) {
  const result=await renderTheme(new MemoryThemeFileSystem(theme.files),item.path,{snapshot,scenario:item.scenario,inspect:true});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(result))))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==item.expected) throw new Error(theme.name+'/'+item.id+' differs from Node');
  rows.push({theme:theme.name,case:item.id,byteParity:true,diagnostics:result.diagnostics.length});
 }
 const after=performance.getEntriesByType('resource').length;
 if(after!==before) throw new Error('Renderer requested network resources');
 window.sopResult={status:'pass',scope:'Initial assembly only; Shopify parity NOT verified',rows,requestsDuringRender:after-before};
 document.querySelector('#status').textContent='PASS: '+rows.length+' initial renders match Node; no renderer network requests. Shopify parity remains pending.';
} catch(error) {
 window.sopResult={status:'fail',error:String(error)};
 document.querySelector('#status').textContent=String(error);
}
</script></html>`;
const server = createServer((request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  const resource =
    request.url === "/"
      ? { body: html, type: "text/html" }
      : request.url === "/bundle.js"
        ? { body: bundle, type: "text/javascript" }
        : request.url === "/cases.json"
          ? { body: payload, type: "application/json" }
          : null;
  if (!resource) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": `${resource.type}; charset=utf-8`,
    "Cache-Control": "no-store",
  });
  response.end(resource.body);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`http://127.0.0.1:${address.port}/`);
});
