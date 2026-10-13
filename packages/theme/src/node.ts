import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ThemeFileSystem, themePath } from "./index.js";

export class NodeThemeFileSystem implements ThemeFileSystem {
  constructor(private readonly root: string) {}

  private async filePath(path: string): Promise<string> {
    const root = await realpath(this.root);
    const target = await realpath(resolve(root, themePath(path)));
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Theme path escapes root: ${path}`);
    }
    return target;
  }

  async readText(path: string): Promise<string> {
    return readFile(await this.filePath(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await this.filePath(path)));
  }

  async listFiles(): Promise<string[]> {
    const root = await realpath(this.root);
    const files: string[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Theme symlinks are unsupported: ${name}`);
        if (entry.isDirectory()) await walk(join(directory, entry.name), `${name}/`);
        else if (entry.isFile()) files.push(name);
      }
    }
    await walk(root, "");
    return files.sort();
  }
}
