import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readBackupKind } from "./read-backup-audit.js";
import { oracleConfigSchema } from "./store-guard.js";
import { auditSupplementalBackup } from "./supplemental-backup-audit.js";

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--kind" ||
    (args[1] !== "collections" &&
      args[1] !== "product-media" &&
      !readBackupKind.safeParse(args[1]).success) ||
    args[2] !== "--archive" ||
    !args[3]
  )
    throw new Error("Invalid arguments");
  const config = oracleConfigSchema.parse(JSON.parse(await readFile(".local/oracle.json", "utf8")));
  const kind =
    args[1] === "collections" || args[1] === "product-media"
      ? args[1]
      : readBackupKind.parse(args[1]);
  const report = await auditSupplementalBackup(config, kind, args[3]);
  await mkdir(".local/results", { recursive: true, mode: 0o700 });
  await writeFile(
    `.local/results/${args[1]}-backup-audit.json`,
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  if (!report.integrityPass) process.exitCode = 2;
} catch {
  console.error("Supplemental backup audit failed; invalid/inaccessible input. Details withheld.");
  process.exitCode = 3;
}
