import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const theme = new MemoryThemeFileSystem({
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "sections/main.liquid":
    "{% if localization.available_countries.size > 1 %}region-form{% endif %}{% if localization.available_languages.size > 1 %}language-form{% endif %}|{{localization.country.iso_code}}:{{localization.country.currency.symbol}}:{{localization.language.endonym_name}}",
});
test("source localization controls selectors and selected values without inventing availability", async () => {
  const snapshot = defaultFixture();
  snapshot.localization = {
    availableCountries: [{ isoCode: "US", currency: { isoCode: "USD", symbol: "$" } }],
    availableLanguages: [{ isoCode: "en", endonymName: "English" }],
    country: "US",
    language: "en",
  };
  let result = await renderTheme(theme, "/", { snapshot, inspect: true });
  assert.ok(result.html.includes("|US:$:English"));
  assert.ok(!result.html.includes("-form"));
  assert.deepEqual(result.diagnostics, []);
  assert.ok(
    Object.values(result.dataUsed).flat().includes("localization.availableCountries[0].isoCode"),
  );
  snapshot.localization.availableCountries.push({ isoCode: "CA" });
  snapshot.localization.availableLanguages.push({ isoCode: "fr", endonymName: "français" });
  snapshot.localization.country = "CA";
  snapshot.localization.language = "fr";
  result = await renderTheme(theme, "/", { snapshot });
  assert.ok(result.html.includes("region-formlanguage-form|CA::français"));
  delete snapshot.localization;
  result = await renderTheme(theme, "/", { snapshot });
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("Localization availability"),
    ),
  );
});
test("selected localization codes must belong to their source availability lists", () => {
  const snapshot = defaultFixture();
  snapshot.localization = {
    availableCountries: [{ isoCode: "US" }],
    availableLanguages: [{ isoCode: "en" }],
    country: "CA",
    language: "fr",
  };
  assert.equal(snapshotSchema.safeParse(snapshot).success, false);
});
