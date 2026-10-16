import type { Diagnostic } from "../../check/src/contracts.js";
import { isBlockedEndpoint } from "./endpoints.js";

interface Region {
  nodeId: string;
  domId?: string;
  markerId?: string;
}
interface Configuration {
  inspectorOrigin: string;
  regions: Region[];
  diagnostics: Diagnostic[];
  path: string;
  designMode?: boolean;
  shopDomain?: string;
  locale?: string;
  currency?: string;
  viewId?: string;
  previewOrigin?: string;
  virtualResources?: Record<string, string>;
}
const element = document.getElementById("sop-bridge-config");
const configuration: Configuration = JSON.parse(element?.textContent ?? "{}");
declare global {
  interface Window {
    Shopify?: Record<string, unknown>;
  }
}
// Only source-backed static context is supplied; no Shopify service APIs are emulated.
window.Shopify ??= {};
const platform = window.Shopify;
platform.designMode = configuration.designMode ?? false;
platform.routes = { root: "/" };
if (configuration.locale) platform.locale = configuration.locale;
if (configuration.currency) platform.currency = { active: configuration.currency };
const prefix = "shopify-offline-preview";
const previewOrigin = configuration.previewOrigin ?? location.origin;
const baseUrl = new URL(configuration.path, previewOrigin).href;
function send(kind: string, value: unknown) {
  if (window.parent !== window)
    window.parent.postMessage(
      { source: prefix, kind, value, viewId: configuration.viewId },
      configuration.inspectorOrigin,
    );
}
const overlay = document.createElement("div");
overlay.id = "sop-region-highlight";
Object.assign(overlay.style, {
  position: "fixed",
  boxSizing: "border-box",
  pointerEvents: "none",
  zIndex: "2147483647",
  border: "2px solid #4168ec",
  background: "rgba(65,104,236,.08)",
  display: "none",
});
const badges = document.createElement("div");
badges.id = "sop-diagnostic-badges";
Object.assign(badges.style, {
  position: "fixed",
  bottom: "12px",
  left: "12px",
  zIndex: "2147483646",
  display: "flex",
  gap: "6px",
  flexWrap: "wrap",
  maxWidth: "80vw",
  font: "12px system-ui",
});
const counts = new Map<string, number>();
function badge(code: string) {
  counts.set(code, (counts.get(code) ?? 0) + 1);
  let node = Array.from(badges.children).find((child) => child.getAttribute("data-code") === code);
  if (!node) {
    node = document.createElement("span");
    node.setAttribute("data-code", code);
    Object.assign(node instanceof HTMLElement ? node.style : {}, {
      background: "#20293a",
      color: "white",
      borderRadius: "6px",
      padding: "6px 8px",
      boxShadow: "0 2px 6px #0003",
    });
    badges.append(node);
  }
  node.textContent = `${code} · ${counts.get(code)}`;
}
for (const diagnostic of configuration.diagnostics)
  if (diagnostic.code !== "shopify-server-only") badge(diagnostic.code);
function report(code: string, message: string) {
  badge(code);
  send("diagnostic", {
    code,
    severity: code === "external-request" ? "info" : "warning",
    file: null,
    line: null,
    nodeId: null,
    message,
  });
}
function blocked(url: URL) {
  return (
    (url.origin === previewOrigin || url.hostname === configuration.shopDomain) &&
    isBlockedEndpoint(url)
  );
}
function request(input: string) {
  let url: URL;
  try {
    url = new URL(input, baseUrl);
    if (
      configuration.virtualResources &&
      url.protocol === "about:" &&
      url.pathname === "srcdoc" &&
      location.href === "about:srcdoc"
    ) {
      // Themes build section requests from location.href in the sandboxed srcdoc frame.
      const current = new URL(baseUrl);
      current.search = url.search;
      current.hash = url.hash;
      url = current;
    }
  } catch {
    return;
  }
  if (blocked(url)) report("blocked-endpoint", `${url.pathname}: not available offline`);
  return url;
}
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const target = request(input instanceof Request ? input.url : String(input));
  if (
    target &&
    (configuration.virtualResources || target.origin !== location.origin) &&
    blocked(target)
  ) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: "not available offline" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (target && configuration.virtualResources && target.origin === previewOrigin) {
    const resource = configuration.virtualResources[target.origin + target.pathname];
    if (resource) return originalFetch(resource, init);
    return Promise.resolve(
      new Response(JSON.stringify({ error: "not available offline" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return originalFetch(input, init);
};
const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  async: boolean = true,
  username?: string | null,
  password?: string | null,
) {
  const target = request(String(url));
  // The virtual preview uses a local data response; override its status to retain the 501 contract.
  for (const name of ["status", "statusText"])
    if (Object.hasOwn(this, name)) Reflect.deleteProperty(this, name);
  const unavailable =
    configuration.virtualResources &&
    target &&
    (blocked(target) ||
      (target.origin === previewOrigin &&
        !configuration.virtualResources[target.origin + target.pathname]));
  if (unavailable) {
    Object.defineProperty(this, "status", {
      configurable: true,
      get: () => (this.readyState < 2 ? 0 : 501),
    });
    Object.defineProperty(this, "statusText", {
      configurable: true,
      get: () => (this.readyState < 2 ? "" : "Not Implemented"),
    });
  }
  const local = unavailable
    ? "data:application/json,%7B%22error%22%3A%22not%20available%20offline%22%7D"
    : target && configuration.virtualResources && target.origin === previewOrigin
      ? (configuration.virtualResources[target.origin + target.pathname] ?? url)
      : target && blocked(target)
        ? new URL(target.pathname + target.search, previewOrigin)
        : url;
  return originalOpen.call(this, method, local, async, username ?? null, password ?? null);
};
const ranges = new Map<string, Range>();
function indexBlockRanges() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
  const stack: { id: string; node: Node }[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.trim() ?? "";
    const open = /^sop:region (\S+)$/.exec(text);
    if (open?.[1]) stack.push({ id: open[1], node });
    else if (text === "/sop:region") {
      const start = stack.pop();
      if (!start) continue;
      const range = document.createRange();
      range.setStartAfter(start.node);
      range.setEndBefore(node);
      ranges.set(start.id, range);
    }
  }
}
function regionRect(region: Region): DOMRect | null {
  if (region.domId) return document.getElementById(region.domId)?.getBoundingClientRect() ?? null;
  return region.markerId ? (ranges.get(region.markerId)?.getBoundingClientRect() ?? null) : null;
}
let selected: Region | undefined;
function highlight(region: Region | undefined) {
  selected = region;
  const rect = region && regionRect(region);
  if (!rect || rect.width === 0 || rect.height === 0) {
    overlay.style.display = "none";
    return;
  }
  Object.assign(overlay.style, {
    display: "block",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}
window.addEventListener("message", (event) => {
  if (event.origin !== configuration.inspectorOrigin || event.source !== window.parent) return;
  const message: unknown = event.data;
  if (
    !message ||
    typeof message !== "object" ||
    !("source" in message) ||
    message.source !== prefix ||
    !("kind" in message)
  )
    return;
  if (message.kind === "highlight" && "value" in message)
    highlight(configuration.regions.find((region) => region.nodeId === message.value));
});
window.addEventListener("scroll", () => highlight(selected), { passive: true });
window.addEventListener("resize", () => highlight(selected));
function ready() {
  indexBlockRanges();
  document.body.append(overlay, badges);
  document.addEventListener("mouseover", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest('[id^="shopify-section-"], [data-sop-block-node]')
        : null;
    const block = [...configuration.regions].reverse().find((region) => {
      if (!region.markerId || !(event.target instanceof Element)) return false;
      const range = ranges.get(region.markerId),
        rect = regionRect(region);
      return (
        range?.intersectsNode(event.target) &&
        rect &&
        rect.width > 0 &&
        rect.height > 0 &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    });
    const region = block ?? configuration.regions.find((region) => region.domId === target?.id);
    if (region) send("select", region.nodeId);
  });
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.target === "_blank" ||
      anchor.hasAttribute("download") ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const url = new URL(anchor.href);
    if (
      url.origin === previewOrigin &&
      !blocked(url) &&
      !/^\/sop\//.test(url.pathname) &&
      !url.hash
    ) {
      event.preventDefault();
      send("navigate", url.pathname + url.search);
    }
  });
  send("ready", configuration.path);
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", ready, { once: true });
else ready();
const external = new Set<string>();
function observe(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    try {
      const url = new URL(entry.name);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin === previewOrigin ||
        external.has(url.href)
      )
        continue;
      external.add(url.href);
      report("external-request", url.href);
    } catch {
      /* Non-URL performance entries are not resource requests. */
    }
  }
}
if (typeof PerformanceObserver !== "undefined") {
  const observer = new PerformanceObserver((list) => observe(list.getEntries()));
  observer.observe({ type: "resource", buffered: true });
}
