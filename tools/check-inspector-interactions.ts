import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { startDevServer } from "../packages/dev/src/server.js";
import { BrowserProtocol } from "./browser/cdp.js";

const root = await mkdtemp(join(tmpdir(), "sop-inspector-interactions-"));
const theme = join(root, "theme");
const data = join(root, "data");
const source = `<h1>{{shop.name}}</h1>{% content_for 'block', type: 'label', id: 'label', label: shop.name %}<p id="mode">{% if request.design_mode %}Design on{% else %}Design off{% endif %}</p><button id="blocked" onclick="fetch('/cart/add.js',{method:'POST'}).then(response=>this.textContent='Local status '+response.status)">Call unsupported endpoint</button><button id="absolute" onclick="fetch('https://example.test/cart/add.js',{method:'POST'}).then(response=>this.textContent='Absolute status '+response.status)">Call absolute endpoint</button>{% schema %}{"settings":[{"type":"product","id":"featured"}]}{% endschema %}`;
for (const [file, text] of Object.entries({
  "layout/theme.liquid":
    "<!doctype html><html><head><title>Inspector interaction test</title></head><body>{{content_for_layout}}</body></html>",
  "templates/index.json": JSON.stringify({
    sections: {
      main: { type: "main", settings: { featured: "absent" } },
      classic: { type: "classic", blocks: { label: { type: "text" } }, block_order: ["label"] },
    },
    order: ["main", "classic"],
  }),
  "sections/main.liquid": source,
  "sections/classic.liquid": `{% for block in section.blocks %}<p id="classic-block" {{block.shopify_attributes}}>{{block.settings.label}}:{{shop.name}}</p>{% endfor %}{% schema %}{"blocks":[{"type":"text","settings":[{"id":"label","type":"text","default":"Classic"}]}]}{% endschema %}`,
  "blocks/label.liquid":
    '<p id="theme-block">Block: {{label}}</p>{% schema %}{"tag":null}{% endschema %}',
})) {
  await mkdir(dirname(join(theme, file)), { recursive: true });
  await writeFile(join(theme, file), text);
}
await mkdir(data, { recursive: true });
await writeFile(join(data, "snapshot.json"), JSON.stringify(defaultFixture()));
const session = await startDevServer({ themeDirectory: theme, dataDirectory: data, port: 0 });
const name = "sop-inspector-interactions";
const execute = promisify(execFile);
const browser = async (...args: string[]) => {
  const { stdout } = await execute("agent-browser", ["--session", name, ...args], {
    encoding: "utf8",
    timeout: 15000,
  });
  return stdout;
};
await browser("open", session.inspectorOrigin);
const client = await BrowserProtocol.connect((await browser("get", "cdp-url")).trim());
const targets = z
  .object({
    targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string() })),
  })
  .parse(await client.call("Target.getTargets"));
const target = targets.targetInfos.find(
  (item) => item.type === "page" && item.url.startsWith(session.inspectorOrigin),
);
assert.ok(target);
const attached = z
  .object({ sessionId: z.string() })
  .parse(await client.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }));
const contexts = new Map<string, number>();
const requests: string[] = [];
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
  if (event.method === "Network.requestWillBeSent") {
    const parsed = z.object({ request: z.object({ url: z.string() }) }).parse(event.params);
    requests.push(parsed.request.url);
  }
});
await client.call("Runtime.enable", {}, attached.sessionId);
await client.call("Page.enable", {}, attached.sessionId);
await client.call("Network.enable", {}, attached.sessionId);
const wait = `async predicate=>{const until=Date.now()+10000;while(!predicate()){if(Date.now()>until)throw new Error('Interaction timed out');await new Promise(resolve=>setTimeout(resolve,25));}}`;
async function parent(expression: string) {
  return client.evaluate(attached.sessionId, expression);
}
async function frameContext() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const frames = z
      .object({
        frameTree: z.object({
          childFrames: z
            .array(z.object({ frame: z.object({ id: z.string(), url: z.string() }) }))
            .optional(),
        }),
      })
      .parse(await client.call("Page.getFrameTree", {}, attached.sessionId));
    const frame = frames.frameTree.childFrames?.find((frame) =>
      frame.frame.url.startsWith(session.previewOrigin),
    );
    const context = frame && contexts.get(frame.frame.id);
    if (context !== undefined) {
      try {
        if (
          await client.evaluate(
            attached.sessionId,
            "!!document.getElementById('sop-diagnostic-badges')",
            context,
          )
        )
          return context;
      } catch {
        /* detaching old iframe */
      }
    }
    await parent("new Promise(resolve=>setTimeout(resolve,25))");
  }
  throw new Error("Preview bridge not ready");
}
async function child(expression: string) {
  return client.evaluate(attached.sessionId, expression, await frameContext());
}
try {
  await parent(
    `(async()=>{await (${wait})(()=>window.SOP_INSPECTOR_STATE?.result && document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  assert.equal(await child("!!document.querySelector('[data-code=missing-resource]')"), true);
  await parent(
    "document.querySelector('#device').value='390';document.querySelector('#device').dispatchEvent(new Event('change'));true",
  );
  assert.equal(
    await parent("document.querySelector('#preview').getBoundingClientRect().width"),
    390,
  );
  const nodeId = await parent("document.querySelector('[data-kind=section]').dataset.nodeId");
  assert.equal(typeof nodeId, "string");
  await parent(
    "document.querySelector('[data-kind=section]').dispatchEvent(new MouseEvent('mouseenter'));true",
  );
  assert.equal(
    await child(
      `(async()=>{await (${wait})(()=>document.querySelector('#sop-region-highlight').style.display==='block');return true;})()`,
    ),
    true,
  );
  await child(
    "document.querySelector('h1').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));true",
  );
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>document.querySelector('[data-kind=section]').getAttribute('aria-pressed')==='true');return true;})()`,
    ),
    true,
  );
  await parent(
    "document.querySelector('[data-kind=block]').dispatchEvent(new MouseEvent('mouseenter'));true",
  );
  assert.equal(
    await child(
      `(async()=>{await (${wait})(()=>{const r=document.querySelector('#theme-block').getBoundingClientRect(),o=document.querySelector('#sop-region-highlight').getBoundingClientRect();return document.querySelector('#sop-region-highlight').style.display==='block'&&o.width>0&&Math.abs(o.top-r.top)<2&&o.height<=r.height+2;});return true;})()`,
    ),
    true,
  );
  await child(
    "(()=>{const element=document.querySelector('#theme-block'),r=element.getBoundingClientRect();element.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:r.left+2,clientY:r.top+2}));return true;})()",
  );
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>document.querySelector('[data-kind=block]').getAttribute('aria-pressed')==='true'&&document.querySelector('#source').textContent.includes('{{label}}'));return true;})()`,
    ),
    true,
  );
  await parent(
    "[...document.querySelectorAll('[data-kind=block]')].at(-1).dispatchEvent(new MouseEvent('mouseenter'));true",
  );
  assert.equal(
    await child(
      `(async()=>{await (${wait})(()=>{const r=document.querySelector('#classic-block').getBoundingClientRect(),o=document.querySelector('#sop-region-highlight').getBoundingClientRect();return document.querySelector('#sop-region-highlight').style.display==='block'&&o.width>0&&Math.abs(o.top-r.top)<2&&o.height<=r.height+2;});return true;})()`,
    ),
    true,
  );
  await child(
    "(()=>{const element=document.querySelector('#classic-block'),r=element.getBoundingClientRect();element.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:r.left+2,clientY:r.top+2}));return true;})()",
  );
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>[...document.querySelectorAll('[data-kind=block]')].at(-1).getAttribute('aria-pressed')==='true'&&document.querySelector('#source').textContent.includes('{{block.settings.label}}'));const id=[...document.querySelectorAll('[data-kind=block]')].at(-1).dataset.nodeId;return window.SOP_INSPECTOR_STATE.result.dataUsed[id].includes('shop.name');})()`,
    ),
    true,
  );
  await child(
    "document.querySelector('#blocked').click();document.querySelector('#absolute').click();true",
  );
  assert.equal(
    await child(
      `(async()=>{await (${wait})(()=>document.querySelector('#blocked').textContent==='Local status 501' && document.querySelector('#absolute').textContent==='Absolute status 501');return !!document.querySelector('[data-code=blocked-endpoint]');})()`,
    ),
    true,
  );
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>window.SOP_INSPECTOR_STATE.runtime.filter(d=>d.code==='blocked-endpoint').length===2);return true;})()`,
    ),
    true,
  );
  assert.ok(
    requests.every((request) => new URL(request).hostname === "127.0.0.1"),
    "Absolute unsupported endpoint went to the real shop",
  );
  await parent("document.querySelector('#design').click();true");
  await parent(
    `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='ready');return true;})()`,
  );
  assert.equal(
    await child(
      `(async()=>{await (${wait})(()=>document.querySelector('#mode').textContent==='Design on');return window.Shopify.designMode;})()`,
    ),
    true,
  );
  await writeFile(
    join(theme, "sections/main.liquid"),
    source.replace("{{shop.name}}", "Edited local section"),
  );
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>window.SOP_INSPECTOR_STATE.result.html.includes('Edited local section'));return true;})()`,
    ),
    true,
  );
  const input = defaultFixture();
  input.shop.name = "Snapshot changed";
  await writeFile(join(data, "snapshot.json"), JSON.stringify(input));
  await writeFile(join(theme, "sections/main.liquid"), source);
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>window.SOP_INSPECTOR_STATE.result.html.includes('Snapshot changed'));return true;})()`,
    ),
    true,
  );
  await writeFile(join(data, "snapshot.json"), "{invalid snapshot");
  assert.equal(
    await parent(
      `(async()=>{await (${wait})(()=>document.querySelector('#status').dataset.state==='error');return window.SOP_INSPECTOR_STATE.result===null && document.querySelectorAll('.tree-node').length===0 && document.querySelector('#preview').hasAttribute('srcdoc');})()`,
    ),
    true,
  );
  const result = {
    status: "pass",
    mobileWidth: 390,
    sectionHighlight: true,
    classicBlockRangeSourceAndReads: true,
    themeBlockRangeHighlight: true,
    themeBlockHoverAndSource: true,
    pageHoverSelection: true,
    missingResourceBadge: true,
    blockedEndpointBadge: true,
    localAndAbsoluteEndpoints501: true,
    storeRequests: 0,
    designMode: true,
    themeHotReload: true,
    snapshotHotReload: true,
    invalidInputClearsPreview: true,
  };
  await writeFile(
    ".local/results/inspector-interactions.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
  await browser("screenshot", join(process.cwd(), ".local/results/inspector-interactions.png"));
} finally {
  client.close();
  await browser("close");
  await session.close();
  await rm(root, { recursive: true, force: true });
}
