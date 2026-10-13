import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeThemeFileSystem } from "../../packages/theme/src/node.js";
import { instrumentLiquid } from "./instrument.js";

/** Returned paths are temporary and must never be committed or uploaded without approval. */
export async function instrumentTheme(
  root: string,
): Promise<{ path: string; classicMarkers: number; themeBlockMarkers: number; files: number }> {
  const fs = new NodeThemeFileSystem(root);
  const files = await fs.listFiles();
  const output = await mkdtemp(join(tmpdir(), "sop-instrumented-"));
  let classicMarkers = 0;
  let themeBlockMarkers = 0;
  for (const file of files) {
    const before = await fs.readBytes(file);
    let bytes = before;
    if (file.endsWith(".liquid")) {
      const result = instrumentLiquid(new TextDecoder().decode(before), file);
      classicMarkers += result.classicMarkers;
      themeBlockMarkers += result.themeBlockMarkers;
      bytes = new TextEncoder().encode(result.source);
    }
    const target = join(output, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const after = await readFile(join(root, file));
    if (
      createHash("sha256").update(before).digest("hex") !==
      createHash("sha256").update(after).digest("hex")
    )
      throw new Error(`Source theme changed during instrumentation: ${file}`);
  }
  return { path: output, classicMarkers, themeBlockMarkers, files: files.length };
}
