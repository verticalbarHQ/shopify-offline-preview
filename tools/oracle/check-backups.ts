import { mkdir, readFile, writeFile } from "node:fs/promises";
import { auditOracleBackups } from "./backup-audit.js";
import { oracleConfigSchema } from "./store-guard.js";

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--catalog" || args[2] !== "--theme" || !args[1] || !args[3])
    throw new Error("Invalid arguments");
  const config = oracleConfigSchema.parse(JSON.parse(await readFile(".local/oracle.json", "utf8")));
  const report = await auditOracleBackups(config, args[1], args[3]);
  await mkdir(".local/results", { recursive: true, mode: 0o700 });
  await writeFile(
    ".local/results/oracle-backup-audit.json",
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
  if (!report.integrityPass) process.exitCode = 2;
} catch {
  console.error(
    "Backup audit failed; invalid or inaccessible input. Details withheld to protect archived data.",
  );
  process.exitCode = 3;
}
