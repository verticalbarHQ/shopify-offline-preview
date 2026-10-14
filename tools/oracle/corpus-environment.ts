import { createHash } from "node:crypto";
import { z } from "zod";
import { themePath } from "../../packages/theme/src/index.js";

export const corpusEnvironmentSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      path: z.string(),
      encoding: z.enum(["utf8", "base64"]),
      content: z.string(),
      provenance: z.literal("authored-fixture"),
    }),
  ),
});
export type CorpusEnvironment = z.infer<typeof corpusEnvironmentSchema>;
export type CorpusFiles = Record<string, string | Uint8Array>;
export const emptyCorpusEnvironment: CorpusEnvironment = { files: [] };
Object.freeze(emptyCorpusEnvironment.files);
Object.freeze(emptyCorpusEnvironment);

/** Only explicit fixture dependencies; generated layouts/templates/snippets cannot be replaced. */
export function corpusDependencyFiles(input: CorpusEnvironment): CorpusFiles {
  const environment = corpusEnvironmentSchema.parse(input);
  const files: CorpusFiles = {};
  for (const file of environment.files) {
    const path = themePath(file.path);
    if (
      /\r|\n/.test(path) ||
      !(
        path.startsWith("assets/") ||
        /^locales\/[^/]+\.json$/.test(path) ||
        ["config/settings_schema.json", "config/settings_data.json"].includes(path)
      )
    )
      throw new Error("Unsupported corpus dependency path");
    if (Object.hasOwn(files, path)) throw new Error("Duplicate corpus dependency path");
    let content: string | Uint8Array = file.content;
    if (file.encoding === "base64") {
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.toString("base64") !== file.content)
        throw new Error("Corpus dependency must use canonical base64");
      content = bytes;
    }
    if (path.endsWith(".json")) {
      try {
        const text =
          typeof content === "string"
            ? content
            : new TextDecoder("utf8", { fatal: true }).decode(content);
        JSON.parse(text);
      } catch {
        throw new Error("Corpus JSON dependency is invalid");
      }
    }
    files[path] = content;
  }
  return files;
}
export function corpusFilesFingerprint(files: CorpusFiles): string {
  const rows = Object.keys(files)
    .sort()
    .map((path) => {
      themePath(path);
      const bytes = files[path];
      if (bytes === undefined) throw new Error("Corpus file content missing");
      return [path, createHash("sha256").update(bytes).digest("hex")];
    });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
