import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { type DevSession, startDevServer } from "../packages/dev/src/server.js";

const manifest = z
  .array(z.object({ name: z.string(), path: z.string() }))
  .length(2)
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
const sessions: DevSession[] = [];
try {
  for (const item of manifest)
    sessions.push(await startDevServer({ themeDirectory: item.path, port: 0 }));
  const { stdout, stderr } = await promisify(execFile)(
    "pnpm",
    [
      "exec",
      "tsx",
      "tools/check-inspector-browser.ts",
      ...sessions.map((session) => session.inspectorOrigin),
    ],
    { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  for (const session of sessions.reverse()) await session.close();
}
