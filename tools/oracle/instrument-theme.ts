import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeThemeFileSystem } from "../../packages/theme/src/node.js";
import {
  captureContextHash,
  captureContextKey,
  captureContextSnippet,
  captureContextSource,
} from "./capture-context.js";
import { instrumentLiquid } from "./instrument.js";

/** Returned paths are temporary and must never be committed or uploaded without approval. */
export async function instrumentTheme(
  root: string,
  options: { captureContext?: boolean } = {},
): Promise<{
  path: string;
  classicMarkers: number;
  themeBlockMarkers: number;
  files: number;
  contextSnippetHash?: string;
}> {
  const fs = new NodeThemeFileSystem(root);
  const files = await fs.listFiles();
  if (
    options.captureContext &&
    (files.includes(captureContextSnippet) ||
      !files.some((file) => /^layout\/[^/]+\.liquid$/.test(file)))
  )
    throw new Error(
      "Comparison capture context requires a layout and an unused reserved snippet path",
    );
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
      if (options.captureContext && /^layout\/[^/]+\.liquid$/.test(file)) {
        if (result.source.includes(captureContextKey))
          throw new Error("Reserved capture context already exists in layout");
        bytes = new TextEncoder().encode(`${result.source}\n{% render '${captureContextKey}' %}`);
      }
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
  if (options.captureContext) {
    await mkdir(join(output, "snippets"), { recursive: true });
    await writeFile(join(output, captureContextSnippet), captureContextSource);
  }
  return {
    path: output,
    classicMarkers,
    themeBlockMarkers,
    files: files.length + (options.captureContext ? 1 : 0),
    ...(options.captureContext ? { contextSnippetHash: captureContextHash } : {}),
  };
}
