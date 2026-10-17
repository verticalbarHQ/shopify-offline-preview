// Side-by-side visual comparison of two storefront origins (for example a Shopify store and the
// offline preview's dev server) for human review. It screenshots each page at each width, extracts
// the section order and each section's visible text, and writes a local HTML report. The browser
// lets only reads through (GET, HEAD, OPTIONS), apart from submitting a configured storefront
// password; every other request, including ones the pages' own scripts send, is blocked.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { BrowserProtocol } from "../browser/cdp.js";

const configSchema = z.strictObject({
  out: z.string().min(1),
  widths: z.array(z.number().int().min(320).max(2560)).min(1),
  sides: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        origin: z.url(),
        // Name of an environment variable holding the storefront password, never the password.
        passwordEnv: z.string().min(1).optional(),
        // CSS selectors hidden before capture, such as the preview's own diagnostic badges.
        hide: z.array(z.string().min(1)).optional(),
        // Query parameters added to every page on this side, such as Shopify's preview_theme_id.
        params: z.record(z.string(), z.string()).optional(),
      }),
    )
    .length(2),
  pages: z.array(z.strictObject({ name: z.string().regex(/^[a-z0-9-]+$/), path: z.string() })),
});
type Config = z.infer<typeof configSchema>;
const capturedSchema = z.object({
  title: z.string(),
  height: z.number(),
  sections: z.array(
    z.object({ id: z.string(), top: z.number(), height: z.number(), lines: z.array(z.string()) }),
  ),
});
type Captured = z.infer<typeof capturedSchema>;

// The element the page scrolls in: the document, or a full-height wrapper some themes scroll instead.
const scroller = `([...document.querySelectorAll("body *")].find(
  (el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight >= innerHeight * 0.8 &&
    /(auto|scroll)/.test(getComputedStyle(el).overflowY),
) ?? document.scrollingElement)`;

// Runs in the page: top-level Shopify sections in document order, with their visible text.
const extract = `(() => {
  const norm = (s) => s.normalize("NFC").replace(/\\s+/g, " ").trim();
  const box = ${scroller};
  const sections = [...document.querySelectorAll('[id^="shopify-section-"]')].filter(
    (el) => !el.parentElement.closest('[id^="shopify-section-"]'),
  );
  return {
    title: document.title,
    height: Math.max(document.documentElement.scrollHeight, box.scrollHeight + box.getBoundingClientRect().top),
    sections: sections.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.id.replace(/^shopify-section-/, "").replace(/--\\d+__/g, "--N__"),
        top: Math.round(rect.top + box.scrollTop),
        height: Math.round(rect.height),
        lines: el.innerText.split("\\n").map(norm).filter(Boolean),
      };
    }),
  };
})()`;

// Lets a full-height scrolling wrapper grow so the document itself scrolls, then scrolls through the
// page so lazily loaded images and sections render before the screenshot.
const settle = (hide: string[]) => `(async () => {
  const box = ${scroller};
  const hidden = document.createElement("style");
  hidden.textContent = ${JSON.stringify(hide.map((h) => `${h}{display:none!important}`).join(""))};
  document.head.append(hidden);
  for (const img of document.images) img.loading = "eager";
  if (box !== document.scrollingElement) {
    box.setAttribute("data-sop-scroller", "");
    const style = document.createElement("style");
    style.textContent = "html,body{height:auto!important;overflow:visible!important}" +
      "[data-sop-scroller]{height:auto!important;max-height:none!important;overflow:visible!important}";
    document.head.append(style);
  }
  for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  await Promise.all([...document.images].map((img) => img.complete ? null :
    new Promise((r) => { img.addEventListener("load", r); img.addEventListener("error", r); setTimeout(r, 5000); })));
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 1000));
  return true;
})()`;

/** A page's URL on one side, with that side's own query parameters added. */
export function pageUrl(origin: string, path: string, params: Record<string, string> = {}): string {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

const pausedSchema = z.object({
  requestId: z.string(),
  request: z.object({ method: z.string(), url: z.string() }),
});
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Lets reads through and, once armed, exactly one POST to the storefront password URL. */
export function requestPolicy() {
  let password: string | null = null;
  const blocked = new Set<string>();
  return {
    blocked,
    allowPasswordOnce(url: string | null) {
      password = url;
    },
    allows(method: string, url: string): boolean {
      if (readMethods.has(method)) return true;
      // The exception is consumed by the first matching POST; a second one is blocked.
      if (method === "POST" && password !== null && url === password) {
        password = null;
        return true;
      }
      blocked.add(`${method} ${url.split("?")[0]}`);
      return false;
    },
  };
}

/** Line-level diff by longest common subsequence: lines only on the left or only on the right. */
export function diffLines(left: string[], right: string[]) {
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      (table[i] as number[])[j] =
        left[i] === right[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (table[i + 1] as number[])[j] as number,
              (table[i] as number[])[j + 1] as number,
            );
  const onlyLeft: string[] = [];
  const onlyRight: string[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i++;
      j++;
    } else if (
      ((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)
    )
      onlyLeft.push(left[i++] as string);
    else onlyRight.push(right[j++] as string);
  }
  onlyLeft.push(...left.slice(i));
  onlyRight.push(...right.slice(j));
  return { onlyLeft, onlyRight };
}

/** Section order, per-section text and height differences between two captures of one page. */
export function compareCaptures(left: Captured, right: Captured) {
  const leftIds = left.sections.map((s) => s.id);
  const rightIds = right.sections.map((s) => s.id);
  const shared = leftIds.filter((id) => rightIds.includes(id));
  const sharedRight = rightIds.filter((id) => leftIds.includes(id));
  return {
    missingRight: leftIds.filter((id) => !rightIds.includes(id)),
    missingLeft: rightIds.filter((id) => !leftIds.includes(id)),
    reordered: shared.join("\n") !== sharedRight.join("\n"),
    sections: shared.map((id) => {
      const a = left.sections.find((s) => s.id === id) as Captured["sections"][number];
      const b = right.sections.find((s) => s.id === id) as Captured["sections"][number];
      return {
        id,
        heights: [a.height, b.height] as [number, number],
        ...diffLines(a.lines, b.lines),
      };
    }),
  };
}

const html = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

function report(config: Config, rows: Row[]): string {
  const [left, right] = config.sides.map((s) => html(s.label)) as [string, string];
  const body = rows
    .map((row) => {
      const c = row.comparison;
      const textDiffs = c.sections.filter((s) => s.onlyLeft.length || s.onlyRight.length);
      const tall = c.sections.filter(
        (s) => Math.abs(s.heights[0] - s.heights[1]) > Math.max(80, 0.25 * Math.max(...s.heights)),
      );
      const flags = [
        c.missingRight.length ? `${c.missingRight.length} section(s) only on ${left}` : "",
        c.missingLeft.length ? `${c.missingLeft.length} section(s) only on ${right}` : "",
        c.reordered ? "section order differs" : "",
        textDiffs.length ? `${textDiffs.length} section(s) with text differences` : "",
        tall.length ? `${tall.length} section(s) with large height differences` : "",
      ].filter(Boolean);
      return `<section id="${row.page}-${row.width}">
<h2>${html(row.page)} <small>${html(row.path)} · ${row.width}px</small></h2>
<p class="${flags.length ? "warn" : "ok"}">${flags.length ? html(flags.join(" · ")) : "Same sections in the same order with the same text"}</p>
${c.missingRight.length ? `<p>Only on ${left}: <code>${html(c.missingRight.join(", "))}</code></p>` : ""}
${c.missingLeft.length ? `<p>Only on ${right}: <code>${html(c.missingLeft.join(", "))}</code></p>` : ""}
<table><tr><th>Section</th><th>${left} height</th><th>${right} height</th><th>Text</th></tr>
${c.sections
  .map(
    (s) =>
      `<tr><td><code>${html(s.id)}</code></td><td>${s.heights[0]}</td><td>${s.heights[1]}</td><td>${
        s.onlyLeft.length || s.onlyRight.length
          ? `<details><summary>differs</summary><div class="diff"><ul class="l">${s.onlyLeft.map((l) => `<li>${html(l)}</li>`).join("")}</ul><ul class="r">${s.onlyRight.map((l) => `<li>${html(l)}</li>`).join("")}</ul></div></details>`
          : "same"
      }</td></tr>`,
  )
  .join("\n")}
</table>
<div class="shots"><figure><figcaption>${left}</figcaption><img loading="lazy" src="${row.images[0]}"></figure><figure><figcaption>${right}</figcaption><img loading="lazy" src="${row.images[1]}"></figure></div>
</section>`;
    })
    .join("\n");
  const index = rows
    .map((r) => `<li><a href="#${r.page}-${r.width}">${html(r.page)} · ${r.width}px</a></li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual comparison</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#111}nav ul{columns:4;padding:0;list-style:none}
section{border-top:2px solid #ccc;margin-top:24px}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ddd;padding:2px 6px;vertical-align:top}
.ok{color:#0a6b2a}.warn{color:#9a5b00;font-weight:600}.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px}
figure{margin:0}img{width:100%;border:1px solid #ccc}.diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.diff ul{margin:0;padding-left:16px}.l li{background:#fde8e8}.r li{background:#e6f4ea}</style></head>
<body><h1>Visual comparison</h1><p>Left: ${left} (${html(config.sides[0]?.origin ?? "")}) · Right: ${right} (${html(config.sides[1]?.origin ?? "")})</p>
<p>Text differences list lines found only on the left (red) or only on the right (green). Heights are in CSS pixels.</p>
<nav><ul>${index}</ul></nav>${body}</body></html>`;
}

interface Row {
  page: string;
  path: string;
  width: number;
  images: [string, string];
  comparison: ReturnType<typeof compareCaptures>;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: visual-compare <config.json>");
  const config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const out = resolve(config.out);
  await mkdir(join(out, "shots"), { recursive: true, mode: 0o700 });
  const session = "sop-visual-compare";
  const browser = (...args: string[]) =>
    execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
  browser("open", "about:blank");
  const client = await BrowserProtocol.connect(browser("get", "cdp-url").trim());
  // Interception on the browser target covers every page, frame and worker.
  const policy = requestPolicy();
  client.on((event) => {
    if (event.method !== "Fetch.requestPaused") return;
    const { requestId, request } = pausedSchema.parse(event.params);
    const allowed = policy.allows(request.method, request.url);
    void client
      .call(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" },
        event.sessionId,
      )
      .catch(() => undefined);
  });
  await client.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  const targets = z
    .object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string() })) })
    .parse(await client.call("Target.getTargets"));
  const target = targets.targetInfos.find((t) => t.type === "page");
  if (!target) throw new Error("No browser page");
  const { sessionId } = z
    .object({ sessionId: z.string() })
    .parse(
      await client.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
    );
  await client.call("Page.enable", {}, sessionId);
  // A background tab throttles timers, which stalls the scroll-through before each capture.
  await client.call("Page.bringToFront", {}, sessionId);
  await client.call("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  const evaluate = (expression: string) => client.evaluate(sessionId, expression);
  const open = async (url: string) => {
    await client.call("Page.navigate", { url }, sessionId);
    for (let i = 0; i < 100; i++) {
      await delay(200);
      if ((await evaluate("document.readyState").catch(() => "")) === "complete") return;
    }
    throw new Error(`Page did not finish loading: ${url}`);
  };
  for (const side of config.sides) {
    if (!side.passwordEnv) continue;
    const password = process.env[side.passwordEnv];
    if (!password) throw new Error(`Environment variable ${side.passwordEnv} is not set`);
    const passwordUrl = new URL("/password", side.origin).href;
    await open(passwordUrl);
    policy.allowPasswordOnce(passwordUrl);
    // Submits after the evaluation returns, so the navigation cannot swallow the reply.
    await evaluate(
      `(() => { const input = document.querySelector('input[type="password"]'); if (!input) return false; input.value = ${JSON.stringify(password)}; setTimeout(() => input.form.submit(), 0); return true; })()`,
    );
    // The submit navigates; reads during the navigation can fail or hang, so poll until it lands.
    let path = "/password";
    for (let i = 0; i < 20 && path.startsWith("/password"); i++) {
      await delay(500);
      path = String(await evaluate("location.pathname").catch(() => "/password"));
    }
    policy.allowPasswordOnce(null);
    if (path.startsWith("/password"))
      throw new Error(`Storefront password was not accepted for ${side.label}`);
  }
  const rows: Row[] = [];
  for (const page of config.pages)
    for (const width of config.widths) {
      await client.call(
        "Emulation.setDeviceMetricsOverride",
        { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 768 },
        sessionId,
      );
      const captures: Captured[] = [];
      const images: string[] = [];
      for (const [index, side] of config.sides.entries()) {
        await open(pageUrl(side.origin, page.path, side.params));
        await evaluate(settle(side.hide ?? []));
        const captured = capturedSchema.parse(await evaluate(extract));
        captures.push(captured);
        const clip = { x: 0, y: 0, width, height: Math.max(1, captured.height), scale: 1 };
        const { data } = z
          .object({ data: z.string() })
          .parse(
            await client.call(
              "Page.captureScreenshot",
              { format: "png", captureBeyondViewport: true, clip },
              sessionId,
            ),
          );
        const file = `shots/${page.name}-${width}-${index ? "right" : "left"}.png`;
        await writeFile(join(out, file), Buffer.from(data, "base64"), { mode: 0o600 });
        images.push(file);
      }
      const [left, right] = captures as [Captured, Captured];
      rows.push({
        page: page.name,
        path: page.path,
        width,
        images: images as [string, string],
        comparison: compareCaptures(left, right),
      });
      console.log(`${page.name} ${width}px captured`);
    }
  client.close();
  browser("close");
  await writeFile(
    join(out, "summary.json"),
    `${JSON.stringify({ blocked: [...policy.blocked].sort(), rows }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Blocked ${policy.blocked.size} non-read request target(s); see summary.json.`);
  await writeFile(join(out, "index.html"), report(config, rows), { mode: 0o600 });
  console.log(`Report: ${join(out, "index.html")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
