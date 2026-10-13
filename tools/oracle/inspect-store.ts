import { readFile } from "node:fs/promises";
import { readOracleIdentity } from "./admin-read.js";
import { oracleConfigSchema } from "./store-guard.js";

try {
  const config = oracleConfigSchema.parse(JSON.parse(await readFile(".local/oracle.json", "utf8")));
  const token = process.env.SOP_ADMIN_ACCESS_TOKEN;
  if (!token)
    throw new Error(
      "SOP_ADMIN_ACCESS_TOKEN is missing. Supply an existing credential through the environment; app/token creation requires owner approval.",
    );
  const identity = await readOracleIdentity(config, token);
  console.log(
    JSON.stringify({
      domainMatches: identity.myshopifyDomain === config.domain,
      partnerDevelopment: identity.plan.partnerDevelopment,
      markerPresent: identity.metafield?.value === "true",
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Oracle inspection failed");
  process.exitCode = 3;
}
