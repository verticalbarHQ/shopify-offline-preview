import { unzipSync } from "fflate";
import { themePath } from "../../theme/src/index.js";

export type BrowserFiles = Record<string, Uint8Array>;
const maximumFiles = 12000;
const maximumBytes = 256 * 1024 * 1024;
const maximumFileBytes = 32 * 1024 * 1024;
/** Validate before stripping a zip's enclosing folder; never normalize away traversal. */
export function normalizeFiles(
  entries: Iterable<[string, Uint8Array]>,
  marker: string,
): BrowserFiles {
  const files: BrowserFiles = Object.create(null);
  let count = 0,
    bytes = 0;
  for (const [name, data] of entries) {
    themePath(name);
    if (Object.hasOwn(files, name)) throw new Error(`Duplicate file: ${name}`);
    count++;
    bytes += data.byteLength;
    if (count > maximumFiles || data.byteLength > maximumFileBytes || bytes > maximumBytes)
      throw new Error(
        "Input exceeds the local file limit (12,000 files, 32 MiB per file, 256 MiB total)",
      );
    files[name] = data;
  }
  let prefix = "";
  if (!Object.hasOwn(files, marker)) {
    const candidates = Object.keys(files).filter((name) => name.endsWith(`/${marker}`));
    if (candidates.length !== 1) throw new Error(`Select a folder or zip containing ${marker}`);
    prefix = candidates[0]?.slice(0, -marker.length) ?? "";
    if (Object.keys(files).some((name) => !name.startsWith(prefix)))
      throw new Error("The archive has files outside its input folder");
  }
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name.slice(prefix.length), data]),
  );
}
export function readZip(bytes: Uint8Array, marker: string): BrowserFiles {
  if (bytes.byteLength > maximumBytes) throw new Error("Zip exceeds 256 MiB");
  let total = 0,
    count = 0;
  const seen = new Set<string>();
  const entries = unzipSync(bytes, {
    filter(file) {
      const name = file.name.endsWith("/") ? file.name.slice(0, -1) : file.name;
      themePath(name);
      if (seen.has(file.name)) throw new Error(`Duplicate zip entry: ${file.name}`);
      seen.add(file.name);
      if (file.name.endsWith("/")) return false;
      count++;
      total += file.originalSize;
      if (count > maximumFiles || file.originalSize > maximumFileBytes || total > maximumBytes)
        throw new Error("Zip expansion exceeds the local file limit");
      return true;
    },
  });
  return normalizeFiles(Object.entries(entries), marker);
}
export async function readSelectedFiles(
  files: FileList | File[],
  marker: string,
): Promise<BrowserFiles> {
  const list = Array.from(files);
  if (list.length === 1 && list[0]?.name.toLowerCase().endsWith(".zip"))
    return readZip(new Uint8Array(await list[0].arrayBuffer()), marker);
  if (
    list.length > maximumFiles ||
    list.reduce((n, f) => n + f.size, 0) > maximumBytes ||
    list.some((f) => f.size > maximumFileBytes)
  )
    throw new Error("Folder exceeds the local file limit");
  const entries = await Promise.all(
    list.map(
      async (f) =>
        [f.webkitRelativePath || f.name, new Uint8Array(await f.arrayBuffer())] as [
          string,
          Uint8Array,
        ],
    ),
  );
  return normalizeFiles(entries, marker);
}
export interface DirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<
    DirectoryHandle | { kind: "file"; name: string; getFile(): Promise<File> }
  >;
}
export async function readDirectory(
  handle: DirectoryHandle,
  marker: string,
): Promise<BrowserFiles> {
  const entries: [string, Uint8Array][] = [];
  let total = 0;
  async function walk(directory: DirectoryHandle, prefix = "") {
    for await (const child of directory.values()) {
      const name = themePath(prefix + child.name);
      if (child.kind === "directory") await walk(child, `${name}/`);
      else {
        const file = await child.getFile();
        total += file.size;
        if (entries.length >= maximumFiles || file.size > maximumFileBytes || total > maximumBytes)
          throw new Error("Folder exceeds the local file limit");
        entries.push([name, new Uint8Array(await file.arrayBuffer())]);
      }
    }
  }
  await walk(handle);
  return normalizeFiles(entries, marker);
}
