import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { CapturedPage } from "./capture.js";
import { publicSummarySchema } from "./summary.js";

export const goldenArtifactSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  theme: z.enum(["dawn", "horizon"]),
  themeCommit: z.string().regex(/^[a-f0-9]{40}$/),
  caseId: z.string().regex(/^[a-z0-9-]+$/),
  path: z.string(),
  scenario: z.string(),
  capturedAt: z.iso.datetime(),
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  doubleCaptureStable: z.literal(true),
  summary: publicSummarySchema,
});
export type GoldenArtifact = z.infer<typeof goldenArtifactSchema>;

export function makeGoldenArtifact(
  capture: CapturedPage,
  metadata: Omit<
    GoldenArtifact,
    "schemaVersion" | "capturedAt" | "doubleCaptureStable" | "summary"
  >,
): GoldenArtifact {
  return goldenArtifactSchema.parse({
    ...metadata,
    schemaVersion: "1.0",
    capturedAt: capture.capturedAt,
    doubleCaptureStable: true,
    summary: capture.publicSummary,
  });
}
export function assertGoldenFreshness(golden: GoldenArtifact, now: Date = new Date()): void {
  goldenArtifactSchema.parse(golden);
  const age = now.getTime() - Date.parse(golden.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 7 * 24 * 60 * 60 * 1000)
    throw new Error("Oracle golden is outside the 7-day release freshness window");
}

/** Private raw material can only be written beneath this project's ignored .local directory. */
export async function savePrivateCapture(
  caseId: string,
  capture: CapturedPage,
): Promise<{ directory: string; rawHashes: string[] }> {
  if (!/^[a-z0-9-]+$/.test(caseId)) throw new Error("Invalid private capture case id");
  const privateRoot = resolve(".local");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(privateRoot)) !== privateRoot)
    throw new Error("Private capture root cannot be a symlink");
  const rawRoot = resolve(privateRoot, "oracle/raw");
  await mkdir(rawRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(rawRoot)) !== rawRoot)
    throw new Error("Private raw path cannot contain symlinks");
  const directory = await mkdtemp(join(rawRoot, `${caseId}-`));
  const rawHashes: string[] = [];
  for (const [index, html] of capture.privateRawHtml.entries()) {
    await writeFile(join(directory, `${index + 1}.html`), html, { mode: 0o600, flag: "wx" });
    rawHashes.push(createHash("sha256").update(html).digest("hex"));
  }
  await writeFile(
    join(directory, "normalized-text.json"),
    `${JSON.stringify(capture.privateSectionText, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return { directory, rawHashes };
}
