import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultTreeAdapterTypes } from "parse5";
import { defaultTreeAdapter, parse, parseFragment, serialize } from "parse5";
import { defaultFixture } from "../../data/src/fixture.js";
import { applyScenario, validateSnapshotReferences } from "../../data/src/scenarios.js";
import { parseSnapshot, type Snapshot } from "../../data/src/schema.js";
import { type RenderNode, type RenderResult, renderTheme } from "../../render/src/index.js";
import { themePath } from "../../theme/src/index.js";
import { NodeThemeFileSystem } from "../../theme/src/node.js";
import { isBlockedEndpoint } from "./endpoints.js";
import { inspectorHtml } from "./shell.js";

export interface DevOptions {
  themeDirectory: string;
  dataDirectory?: string;
  scenario?: string;
  designMode?: boolean;
  port?: number;
}
export interface DevSession {
  inspectorOrigin: string;
  previewOrigin: string;
  close(): Promise<void>;
}
interface Region {
  nodeId: string;
  domId: string;
}
const mime: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
const sourceDevelopment = import.meta.url.endsWith("/server.ts");
const assets = (name: string) =>
  new URL(sourceDevelopment ? `../../../dist/${name}` : `./${name}`, import.meta.url);
const fixtureImages = fileURLToPath(
  new URL(
    sourceDevelopment ? "../../../fixtures/default/images/" : "../fixtures/default/images/",
    import.meta.url,
  ),
);

export function previewRegions(tree: RenderNode[]): Region[] {
  const result: Region[] = [];
  function walk(nodes: RenderNode[]) {
    for (const node of nodes) {
      if (node.kind === "section" && node.settingsPath) {
        const [file, pointer] = node.settingsPath.split("#/sections/");
        const id = pointer?.replaceAll("~1", "/").replaceAll("~0", "~");
        if (id !== undefined)
          result.push({
            nodeId: node.id,
            domId: `shopify-section-${file?.startsWith("templates/") ? "template--0__" : file?.startsWith("sections/") ? "sections--0__" : ""}${id}`,
          });
      }
      walk(node.children);
    }
  }
  walk(tree);
  return result;
}
export function servedPreview(
  result: RenderResult,
  inspectorOrigin: string,
  context: {
    designMode?: boolean;
    shopDomain?: string;
    locale?: string;
    currency?: string;
    viewId?: string;
  } = {},
): string {
  const config = JSON.stringify({
    inspectorOrigin,
    regions: previewRegions(result.tree),
    diagnostics: result.diagnostics,
    path: result.route.path,
    ...context,
  }).replaceAll("<", "\\u003c");
  const document = parse(result.html);
  let head: DefaultTreeAdapterTypes.Element | undefined;
  function find(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node && node.tagName === "head") head = node;
    if ("childNodes" in node) node.childNodes.forEach(find);
  }
  find(document);
  if (!head) throw new Error("Preview document has no head");
  const fragment = parseFragment(
    `<script id="sop-bridge-config" type="application/json">${config}</script><script src="/sop/bridge.js"></script>`,
  );
  const first = head.childNodes[0];
  for (const child of [...fragment.childNodes]) {
    if (first) defaultTreeAdapter.insertBefore(head, child, first);
    else defaultTreeAdapter.appendChild(head, child);
  }
  return serialize(document);
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
function trust(request: IncomingMessage, response: ServerResponse, origin: string): boolean {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  const expected = new URL(origin);
  if (
    request.headers.host !== expected.host ||
    (request.headers.origin && request.headers.origin !== origin) ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    json(response, 403, { error: "Local server request origin rejected" });
    return false;
  }
  return true;
}
async function listen(server: Server, port: number): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startDevServer(options: DevOptions): Promise<DevSession> {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65534)
    throw new Error("Port must be an integer between 0 and 65534");
  const theme = new NodeThemeFileSystem(options.themeDirectory);
  await theme.listFiles();
  async function snapshot(): Promise<Snapshot> {
    const result = options.dataDirectory
      ? parseSnapshot(await readFile(join(options.dataDirectory, "snapshot.json"), "utf8"))
      : defaultFixture();
    validateSnapshotReferences(result);
    return result;
  }
  applyScenario(await snapshot(), options.scenario);
  const [inspectorScript, bridgeScript] = await Promise.all([
    readFile(assets("inspector.js")),
    readFile(assets("bridge.js")),
  ]);
  let inspectorOrigin = "";
  let previewOrigin = "";
  let revision = 0;
  const events = new Set<ServerResponse>();
  const cache = new Map<string, Promise<RenderResult>>();
  const watchers: FSWatcher[] = [];
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const currentInput = (url: URL) => {
    const path = url.pathname + url.search;
    return {
      path,
      scenario: url.searchParams.get("__sop_scenario") ?? options.scenario ?? "default",
      designMode: url.searchParams.has("__sop_design_mode")
        ? url.searchParams.get("__sop_design_mode") === "true"
        : (options.designMode ?? false),
    };
  };
  async function render(
    path: string,
    scenario: string,
    designMode: boolean,
  ): Promise<RenderResult> {
    const key = JSON.stringify([revision, path, scenario, designMode]);
    let pending = cache.get(key);
    if (!pending) {
      pending = snapshot().then((snapshot) =>
        renderTheme(theme, path, { snapshot, scenario, designMode, inspect: true }),
      );
      cache.set(key, pending);
      // A bounded cache avoids retaining every path typed during a long editing session.
      if (cache.size > 64) cache.delete(cache.keys().next().value ?? "");
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    return pending;
  }
  function changed() {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      revision++;
      cache.clear();
      for (const response of events) response.write(`event: changed\ndata: ${revision}\n\n`);
    }, 75);
  }
  async function inspector(request: IncomingMessage, response: ServerResponse) {
    if (!trust(request, response, inspectorOrigin)) return;
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src ${previewOrigin}; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    if (request.method !== "GET") {
      request.resume();
      json(response, 405, { error: "Inspector is read-only" });
      return;
    }
    const url = new URL(request.url ?? "/", inspectorOrigin);
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(inspectorHtml);
      return;
    }
    if (url.pathname === "/inspector.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(inspectorScript);
      return;
    }
    if (url.pathname === "/api/config") {
      const data = await snapshot();
      json(response, 200, {
        previewOrigin,
        scenarios: [
          "default",
          ...Object.keys(data.scenarios)
            .filter((name) => name !== "default")
            .sort(),
        ],
        scenario: options.scenario ?? "default",
        designMode: options.designMode ?? false,
      });
      return;
    }
    if (url.pathname === "/api/render") {
      json(
        response,
        200,
        await render(
          url.searchParams.get("path") ?? "/",
          url.searchParams.get("scenario") ?? options.scenario ?? "default",
          url.searchParams.get("designMode") === "true",
        ),
      );
      return;
    }
    if (url.pathname === "/api/source") {
      const file = themePath(url.searchParams.get("file") ?? "");
      if (
        !/^(?:layout|sections|blocks|snippets)\/.*\.(?:liquid|json)$/.test(file) ||
        !(await theme.listFiles()).includes(file)
      ) {
        json(response, 404, { error: "Source file is not a theme node" });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(await theme.readText(file));
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(`event: connected\ndata: ${revision}\n\n`);
      events.add(response);
      request.once("close", () => events.delete(response));
      return;
    }
    json(response, 404, { error: "Unknown inspector route" });
  }
  async function preview(request: IncomingMessage, response: ServerResponse) {
    if (!trust(request, response, previewOrigin)) return;
    const url = new URL(request.url ?? "/", previewOrigin);
    if (request.method !== "GET" || isBlockedEndpoint(url)) {
      request.resume();
      json(response, 501, { error: "not available offline" });
      return;
    }
    if (url.pathname === "/sop/bridge.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(bridgeScript);
      return;
    }
    if (url.pathname.startsWith("/sop/assets/")) {
      const file = themePath(
        `assets/${decodeURIComponent(url.pathname.slice("/sop/assets/".length))}`,
      );
      try {
        const bytes = await theme.readBytes(file);
        response.writeHead(200, {
          "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        });
        response.end(bytes);
      } catch {
        json(response, 404, { error: "Theme asset not found" });
      }
      return;
    }
    if (url.pathname.startsWith("/sop/images/")) {
      const file = themePath(decodeURIComponent(url.pathname.slice("/sop/images/".length)));
      const data = await snapshot();
      const images = [
        ...data.products.flatMap((product) => product.images),
        ...data.collections.flatMap((collection) => (collection.image ? [collection.image] : [])),
        ...data.blogs.flatMap((blog) =>
          blog.articles.flatMap((article) => (article.image ? [article.image] : [])),
        ),
      ];
      try {
        if (!images.some((image) => image.file === file))
          throw new Error("Image is absent from the snapshot");
        const fs = new NodeThemeFileSystem(
          options.dataDirectory ? join(options.dataDirectory, "images") : fixtureImages,
        );
        const bytes = await fs.readBytes(file);
        response.writeHead(200, {
          "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        });
        response.end(bytes);
      } catch {
        const dimension = (key: string) =>
          Math.min(8192, Math.max(1, Number(url.searchParams.get(key)) || 64));
        response.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
        response.end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension("width")}" height="${dimension("height")}" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e2e8f0"/><path d="M12 46l14-16 10 9 7-7 9 14z" fill="#94a3b8"/><circle cx="44" cy="20" r="6" fill="#94a3b8"/></svg>`,
        );
      }
      return;
    }
    if (url.pathname.startsWith("/sop/")) {
      json(response, 404, { error: "Unknown preview resource" });
      return;
    }
    const input = currentInput(url);
    const originalRoute = url.searchParams.get("__sop_route");
    const viewId = url.searchParams.get("__sop_view") ?? "";
    url.searchParams.delete("__sop_scenario");
    url.searchParams.delete("__sop_design_mode");
    url.searchParams.delete("__sop_route");
    url.searchParams.delete("__sop_view");
    const result = await render(
      originalRoute ?? url.pathname + url.search,
      input.scenario,
      input.designMode,
    );
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const data = await snapshot();
    response.end(
      servedPreview(result, inspectorOrigin, {
        designMode: input.designMode,
        shopDomain: data.shop.domain,
        locale: data.shop.locale,
        currency: data.shop.currency,
        viewId,
      }),
    );
  }
  const handler =
    (callback: (request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
    (request: IncomingMessage, response: ServerResponse) => {
      void callback(request, response).catch((error) => {
        if (!response.headersSent)
          json(response, 400, {
            error: error instanceof Error ? error.message : "Local preview failed",
          });
        else response.end();
      });
    };
  const inspectorServer = createServer(handler(inspector));
  const previewServer = createServer(handler(preview));
  try {
    inspectorOrigin = await listen(inspectorServer, port);
    previewOrigin = await listen(previewServer, port === 0 ? 0 : port + 1);
    watchers.push(watch(options.themeDirectory, { recursive: true }, changed));
    if (options.dataDirectory)
      watchers.push(watch(options.dataDirectory, { recursive: true }, changed));
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    if (inspectorServer.listening) await close(inspectorServer);
    if (previewServer.listening) await close(previewServer);
    throw error;
  }
  let closed = false;
  return {
    inspectorOrigin,
    previewOrigin,
    async close() {
      if (closed) return;
      closed = true;
      if (changeTimer) clearTimeout(changeTimer);
      for (const watcher of watchers) watcher.close();
      for (const response of events) response.end();
      events.clear();
      cache.clear();
      await Promise.all([close(inspectorServer), close(previewServer)]);
    },
  };
}
