import { defaultFixture } from "../../data/src/fixture.js";
import { snapshotImages } from "../../data/src/images.js";
import { applyScenario, validateSnapshotReferences } from "../../data/src/scenarios.js";
import { parseSnapshot, type Snapshot } from "../../data/src/schema.js";
import type { InspectorTransport } from "../../dev/src/transport.js";
import { renderTheme } from "../../render/src/index.js";
import { MemoryThemeFileSystem } from "../../theme/src/index.js";
import {
  type BrowserFiles,
  type DirectoryHandle,
  readDirectory,
  readSelectedFiles,
} from "./files.js";
import { playgroundPreview } from "./preview.js";

let theme: MemoryThemeFileSystem | undefined;
let themeFiles: BrowserFiles = Object.create(null);
let snapshot = defaultFixture();
let images: BrowserFiles = Object.create(null);
let themeHandle: DirectoryHandle | undefined;
let dataHandle: DirectoryHandle | undefined;
let started = false;
let changed = () => {};
let revision = 0;
const errors: { theme: string | null; snapshot: string | null } = { theme: null, snapshot: null };
const selections = { theme: 0, snapshot: 0 };
const status = document.querySelector<HTMLElement>("#input-status");
const refresh = document.querySelector<HTMLButtonElement>("#reload-folder");
const staticRoot = new URL("./", import.meta.url);
const bridgePromise = fetch(new URL("bridge.js", staticRoot)).then(async (response) => {
  if (!response.ok) throw new Error("Preview script unavailable");
  return response.text();
});
function notify(message: string, error = false) {
  if (status) {
    status.textContent = message;
    status.dataset.state = error ? "error" : "ready";
  }
}
function fail(kind: "theme" | "snapshot", error: unknown) {
  errors[kind] = String(error);
  revision++;
  notify(String(error), true);
  if (started) changed();
}
function imageNames(value: Snapshot): string[] {
  return [...new Set(snapshotImages(value).map((image) => image.file))];
}
const defaultImages = Promise.all(
  imageNames(snapshot).map(async (file) => {
    const response = await fetch(new URL(`images/${file}`, staticRoot));
    if (!response.ok) throw new Error(`Fixture image unavailable: ${file}`);
    return [file, new Uint8Array(await response.arrayBuffer())] as [string, Uint8Array];
  }),
).then((entries) => Object.fromEntries(entries));
async function mount() {
  if (refresh) refresh.disabled = !themeHandle && !dataHandle;
  if (!theme) return;
  if (!started) {
    started = true;
    await import("../../dev/src/inspector.js");
  } else changed();
}
async function setTheme(files: BrowserFiles) {
  errors.theme = null;
  themeFiles = files;
  theme = new MemoryThemeFileSystem(files);
  revision++;
  notify(`${Object.keys(files).length} theme files · processed in this browser`);
  await mount();
}
async function setSnapshot(files: BrowserFiles) {
  const content = files["snapshot.json"];
  if (!content) throw new Error("snapshot.json is missing");
  const value = parseSnapshot(new TextDecoder().decode(content));
  validateSnapshotReferences(value);
  const localImages: BrowserFiles = Object.create(null);
  for (const file of imageNames(value)) {
    const bytes = files[`images/${file}`];
    if (!bytes) throw new Error(`Snapshot image missing: images/${file}`);
    localImages[file] = bytes;
  }
  errors.snapshot = null;
  snapshot = value;
  images = localImages;
  revision++;
  notify("Snapshot and images loaded in this browser");
  await mount();
}
const transport: InspectorTransport = {
  async config() {
    return { previewOrigin: "null", scenarios: ["default", ...Object.keys(snapshot.scenarios)] };
  },
  async render(input, signal) {
    if (errors.theme || errors.snapshot)
      throw new Error(errors.theme ?? errors.snapshot ?? "Invalid input");
    if (!theme) throw new Error("Open a theme zip or folder first");
    const result = await renderTheme(theme, input.path, {
      snapshot,
      scenario: input.scenario,
      designMode: input.designMode,
      inspect: true,
    });
    signal.throwIfAborted();
    return result;
  },
  async source(file) {
    if (!theme) throw new Error("Theme is missing");
    return theme.readText(file);
  },
  async preview(frame, result, input, viewId, signal) {
    const current = revision;
    const localImages = Object.keys(images).length ? images : await defaultImages;
    const html = await playgroundPreview(
      result,
      applyScenario(snapshot, input.scenario),
      themeFiles,
      localImages,
      await bridgePromise,
      input.designMode,
      viewId,
      location.origin,
    );
    if (current !== revision || signal.aborted) return;
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.removeAttribute("src");
    frame.srcdoc = html;
  },
  subscribe(callback) {
    changed = callback;
  },
};
window.SOP_INSPECTOR_TRANSPORT = transport;
async function loadInput(
  kind: "theme" | "snapshot",
  read: () => Promise<BrowserFiles>,
  handle?: DirectoryHandle,
) {
  const sequence = ++selections[kind];
  if (kind === "theme") themeHandle = handle;
  else dataHandle = handle;
  if (refresh) refresh.disabled = !themeHandle && !dataHandle;
  try {
    const files = await read();
    if (sequence !== selections[kind]) return;
    if (kind === "theme") await setTheme(files);
    else await setSnapshot(files);
  } catch (error) {
    if (sequence === selections[kind]) fail(kind, error);
  }
}
function input(id: string, kind: "theme" | "snapshot") {
  document.querySelector<HTMLInputElement>(id)?.addEventListener("change", (event) => {
    const files = event.target instanceof HTMLInputElement ? event.target.files : null;
    if (files?.length)
      void loadInput(kind, () =>
        readSelectedFiles(files, kind === "theme" ? "layout/theme.liquid" : "snapshot.json"),
      );
  });
}
input("#theme-zip", "theme");
input("#theme-folder", "theme");
input("#snapshot-zip", "snapshot");
input("#snapshot-folder", "snapshot");
interface FilePickerWindow {
  showDirectoryPicker?: () => Promise<DirectoryHandle>;
}
async function picker(kind: "theme" | "snapshot") {
  const show = (window as Window & FilePickerWindow).showDirectoryPicker;
  if (!show) {
    document
      .querySelector<HTMLInputElement>(kind === "theme" ? "#theme-folder" : "#snapshot-folder")
      ?.click();
    return;
  }
  try {
    const handle = await show.call(window);
    await loadInput(
      kind,
      () => readDirectory(handle, kind === "theme" ? "layout/theme.liquid" : "snapshot.json"),
      handle,
    );
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) fail(kind, error);
  }
}
document.querySelector("#open-theme-folder")?.addEventListener("click", () => void picker("theme"));
document
  .querySelector("#open-snapshot-folder")
  ?.addEventListener("click", () => void picker("snapshot"));
refresh?.addEventListener("click", () => {
  const theme = themeHandle,
    data = dataHandle;
  if (theme) void loadInput("theme", () => readDirectory(theme, "layout/theme.liquid"), theme);
  if (data) void loadInput("snapshot", () => readDirectory(data, "snapshot.json"), data);
});
document.querySelector("#default-snapshot")?.addEventListener("click", () => {
  selections.snapshot++;
  errors.snapshot = null;
  snapshot = defaultFixture();
  images = Object.create(null);
  dataHandle = undefined;
  revision++;
  notify("Using the bundled fixture");
  void mount();
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  void loadInput("theme", () => readSelectedFiles(files, "layout/theme.liquid"));
});
notify("Open a theme zip or folder. Your files stay in this browser.");
