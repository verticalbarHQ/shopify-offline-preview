import { defaultFixture } from "../../data/src/fixture.js";
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
function imageNames(value: Snapshot): string[] {
  return [
    ...new Set([
      ...value.products.flatMap((p) => p.images.map((i) => i.file)),
      ...value.collections.flatMap((c) => (c.image ? [c.image.file] : [])),
      ...value.blogs.flatMap((b) => b.articles.flatMap((a) => (a.image ? [a.image.file] : []))),
    ]),
  ];
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
function input(id: string, kind: "theme" | "snapshot") {
  document.querySelector<HTMLInputElement>(id)?.addEventListener("change", (event) => {
    const files = event.target instanceof HTMLInputElement ? event.target.files : null;
    if (!files?.length) return;
    void (async () => {
      const data = await readSelectedFiles(
        files,
        kind === "theme" ? "layout/theme.liquid" : "snapshot.json",
      );
      if (kind === "theme") {
        themeHandle = undefined;
        await setTheme(data);
      } else {
        dataHandle = undefined;
        await setSnapshot(data);
      }
    })().catch((error) => notify(String(error), true));
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
    const handle = await show();
    const files = await readDirectory(
      handle,
      kind === "theme" ? "layout/theme.liquid" : "snapshot.json",
    );
    if (kind === "theme") {
      themeHandle = handle;
      await setTheme(files);
    } else {
      dataHandle = handle;
      await setSnapshot(files);
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      notify(String(error), true);
  }
}
document.querySelector("#open-theme-folder")?.addEventListener("click", () => void picker("theme"));
document
  .querySelector("#open-snapshot-folder")
  ?.addEventListener("click", () => void picker("snapshot"));
refresh?.addEventListener("click", () => {
  void (async () => {
    if (themeHandle) await setTheme(await readDirectory(themeHandle, "layout/theme.liquid"));
    if (dataHandle) await setSnapshot(await readDirectory(dataHandle, "snapshot.json"));
  })().catch((error) => notify(String(error), true));
});
document.querySelector("#default-snapshot")?.addEventListener("click", () => {
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
  void readSelectedFiles(files, "layout/theme.liquid")
    .then(setTheme)
    .catch((error) => notify(String(error), true));
});
notify("Open a theme zip or folder. Your files stay in this browser.");
