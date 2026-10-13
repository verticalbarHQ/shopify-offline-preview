import { diagnosticSchema } from "../../check/src/contracts.js";
import { type RenderNode, type RenderResult, renderSchema } from "../../render/src/contracts.js";

import { localTransport } from "./transport.js";

const transport = window.SOP_INSPECTOR_TRANSPORT ?? localTransport;

const prefix = "shopify-offline-preview";
function element<T extends HTMLElement>(selector: string, elementType: { new (): T }): T {
  const result = document.querySelector(selector);
  if (!(result instanceof elementType)) throw new Error(`Missing inspector element ${selector}`);
  return result;
}
const frame = element("#preview", HTMLIFrameElement);
const path = element("#path", HTMLInputElement);
const scenario = element("#scenario", HTMLSelectElement);
const design = element("#design", HTMLInputElement);
const status = element("#status", HTMLParagraphElement);
const tree = element("#tree", HTMLDivElement);
const diagnostics = element("#diagnostics", HTMLDivElement);
const runtime = element("#runtime", HTMLDivElement);
const reads = element("#reads", HTMLDivElement);
const source = element("#source", HTMLPreElement);
let previewOrigin = "";
let controller: AbortController | undefined;
let generation = 0;
let current: RenderResult | null = null;
let selected: string | null = null;
let activeView = "";
const nodeElements = new Map<string, HTMLButtonElement>();
declare global {
  interface Window {
    SOP_INSPECTOR_STATE: { result: RenderResult | null; runtime: unknown[]; previewOrigin: string };
  }
}
window.SOP_INSPECTOR_STATE = { result: null, runtime: [], previewOrigin: "" };
function message(kind: string, value: unknown) {
  frame.contentWindow?.postMessage(
    { source: prefix, kind, value },
    previewOrigin === "null" ? "*" : previewOrigin,
  );
}
function showDiagnostic(value: unknown, parent: HTMLElement) {
  const parsed = diagnosticSchema.safeParse(value);
  if (!parsed.success) return;
  const diagnostic = parsed.data;
  const item = document.createElement("div");
  item.className = `diagnostic ${diagnostic.severity}`;
  item.dataset.code = diagnostic.code;
  const code = document.createElement("strong");
  code.textContent = diagnostic.code;
  const text = document.createElement("span");
  text.textContent = diagnostic.message;
  const file = document.createElement("small");
  file.textContent = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
    : "";
  item.append(code, text, file);
  parent.append(item);
}
async function select(id: string) {
  selected = id;
  for (const [key, node] of nodeElements) node.setAttribute("aria-pressed", String(key === id));
  const paths = current?.dataUsed[id] ?? [];
  reads.replaceChildren();
  if (!paths.length) reads.textContent = "No snapshot reads recorded for this node.";
  for (const path of paths) {
    const code = document.createElement("code");
    code.textContent = path;
    reads.append(code);
  }
  const find = (nodes: RenderNode[]): RenderNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const child = find(node.children);
      if (child) return child;
    }
    return undefined;
  };
  const node = current && find(current.tree);
  if (!node) return;
  source.textContent = `${node.file}\nLoading source…`;
  try {
    const text = await transport.source(node.file);
    if (selected === id)
      source.textContent = `${node.file}${node.settingsPath ? `\n${node.settingsPath}` : ""}\n\n${text}`;
  } catch (error) {
    if (selected === id) source.textContent = String(error);
  }
}
function appendNodes(nodes: RenderNode[], parent: HTMLElement, depth = 0) {
  for (const node of nodes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-node";
    button.dataset.nodeId = node.id;
    button.dataset.kind = node.kind;
    button.dataset.file = node.file;
    button.style.paddingLeft = `${12 + depth * 16}px`;
    button.setAttribute("aria-pressed", "false");
    const kind = document.createElement("small");
    kind.textContent = node.kind;
    const name = document.createElement("span");
    name.textContent = node.type;
    button.append(kind, name);
    button.addEventListener("mouseenter", () => message("highlight", node.id));
    button.addEventListener("mouseleave", () => message("highlight", null));
    button.addEventListener("click", () => {
      void select(node.id);
    });
    nodeElements.set(node.id, button);
    parent.append(button);
    appendNodes(node.children, parent, depth + 1);
  }
}
async function load() {
  const sequence = ++generation;
  controller?.abort();
  controller = new AbortController();
  status.textContent = "Rendering…";
  status.dataset.state = "loading";
  try {
    const input = {
      path: path.value,
      scenario: scenario.value || "default",
      designMode: design.checked,
    };
    const result = renderSchema.parse(await transport.render(input, controller.signal));
    if (sequence !== generation) return;
    current = result;
    window.SOP_INSPECTOR_STATE.result = result;
    window.SOP_INSPECTOR_STATE.runtime = [];
    tree.replaceChildren();
    diagnostics.replaceChildren();
    runtime.replaceChildren();
    reads.replaceChildren();
    source.textContent = "Select a node to inspect its source.";
    nodeElements.clear();
    selected = null;
    appendNodes(result.tree, tree);
    for (const diagnostic of result.diagnostics) showDiagnostic(diagnostic, diagnostics);
    activeView = String(sequence);
    await transport.preview(frame, result, input, activeView, controller.signal);
    if (sequence !== generation) return;
    status.textContent = `${result.route.pageType} · ${result.diagnostics.length} diagnostics`;
    status.dataset.state = "ready";
    const saved = new URL(location.href);
    saved.searchParams.set("path", path.value);
    saved.searchParams.set("scenario", scenario.value);
    saved.searchParams.set("design", String(design.checked));
    history.replaceState(null, "", saved);
  } catch (error) {
    if (sequence !== generation || controller.signal.aborted) return;
    current = null;
    window.SOP_INSPECTOR_STATE.result = null;
    selected = null;
    nodeElements.clear();
    runtime.replaceChildren();
    window.SOP_INSPECTOR_STATE.runtime = [];
    tree.replaceChildren();
    diagnostics.replaceChildren();
    reads.replaceChildren();
    source.textContent = "Preview input could not be rendered.";
    frame.srcdoc = "";
    status.textContent = String(error);
    status.dataset.state = "error";
  }
}
window.addEventListener("message", (event) => {
  if (event.origin !== previewOrigin || event.source !== frame.contentWindow) return;
  const message: unknown = event.data;
  if (
    !message ||
    typeof message !== "object" ||
    !("source" in message) ||
    message.source !== prefix ||
    !("kind" in message) ||
    !("value" in message)
  )
    return;
  if (!("viewId" in message) || message.viewId !== activeView || !current) return;
  if (
    message.kind === "select" &&
    typeof message.value === "string" &&
    nodeElements.has(message.value)
  )
    void select(message.value);
  if (
    message.kind === "navigate" &&
    typeof message.value === "string" &&
    message.value.startsWith("/") &&
    !message.value.startsWith("//")
  ) {
    path.value = message.value;
    void load();
  }
  if (message.kind === "diagnostic") {
    const diagnostic = diagnosticSchema.safeParse(message.value);
    if (
      diagnostic.success &&
      ["blocked-endpoint", "external-request"].includes(diagnostic.data.code)
    ) {
      window.SOP_INSPECTOR_STATE.runtime.push(diagnostic.data);
      showDiagnostic(diagnostic.data, runtime);
    }
  }
});
element("#controls", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void load();
});
scenario.addEventListener("change", () => {
  void load();
});
design.addEventListener("change", () => {
  void load();
});
element("#device", HTMLSelectElement).addEventListener("change", (event) => {
  const value = event.target instanceof HTMLSelectElement ? event.target.value : "full";
  frame.style.width = value === "full" ? "100%" : `${Number(value)}px`;
});
element("#collapse", HTMLButtonElement).addEventListener("click", () => {
  document.body.classList.toggle("collapsed");
  element("#collapse", HTMLButtonElement).setAttribute(
    "aria-expanded",
    String(!document.body.classList.contains("collapsed")),
  );
});
async function start() {
  const config: unknown = await transport.config();
  if (
    !config ||
    typeof config !== "object" ||
    !("previewOrigin" in config) ||
    typeof config.previewOrigin !== "string" ||
    !("scenarios" in config) ||
    !Array.isArray(config.scenarios)
  )
    throw new Error("Invalid configuration");
  previewOrigin = config.previewOrigin;
  window.SOP_INSPECTOR_STATE.previewOrigin = previewOrigin;
  for (const name of config.scenarios)
    if (typeof name === "string") {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      scenario.append(option);
    }
  const query = new URL(location.href).searchParams;
  path.value = query.get("path") ?? "/";
  scenario.value =
    query.get("scenario") ??
    ("scenario" in config && typeof config.scenario === "string" ? config.scenario : "default");
  design.checked = query.has("design")
    ? query.get("design") === "true"
    : "designMode" in config && config.designMode === true;
  if (!scenario.value) scenario.value = "default";
  transport.subscribe(
    () => {
      void (async () => {
        try {
          {
            const updated: unknown = await transport.config();
            if (
              updated &&
              typeof updated === "object" &&
              "scenarios" in updated &&
              Array.isArray(updated.scenarios)
            ) {
              const previous = scenario.value;
              scenario.replaceChildren();
              for (const name of updated.scenarios)
                if (typeof name === "string") {
                  const option = document.createElement("option");
                  option.value = name;
                  option.textContent = name;
                  scenario.append(option);
                }
              scenario.value = previous;
              if (!scenario.value) scenario.value = "default";
            }
          }
        } finally {
          await load();
        }
      })().catch((error) => {
        status.textContent = String(error);
        status.dataset.state = "error";
      });
    },
    () => {
      status.textContent = "Waiting for the local server…";
    },
  );
  await load();
}
void start().catch((error) => {
  status.textContent = String(error);
  status.dataset.state = "error";
});
