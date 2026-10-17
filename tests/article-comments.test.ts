import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const theme = new MemoryThemeFileSystem({
  "templates/article.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
  "sections/main.liquid":
    "[{{ blog.moderated? }}]{% paginate article.comments by 5 %}{{ article.comments.size }}/{{ paginate.pages }}{% endpaginate %}",
});

test("comment moderation comes from the snapshot; an article without comments has an empty list", async () => {
  const snapshot = defaultFixture();
  const blog = snapshot.blogs[0];
  const article = blog?.articles[0];
  assert.ok(blog && article);
  blog.commentsModerated = true;
  article.commentsCount = 0;
  const result = await renderTheme(theme, `/blogs/${blog.handle}/${article.handle}`, { snapshot });
  assert.ok(result.html.includes("[true]0/0"), result.html);
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code !== "shopify-server-only"),
    [],
  );
});

test("comments the snapshot does not carry are reported as missing data", async () => {
  const snapshot = defaultFixture();
  const blog = snapshot.blogs[0];
  const article = blog?.articles[0];
  assert.ok(blog && article);
  article.commentsCount = 2;
  delete blog.commentsModerated;
  const result = await renderTheme(theme, `/blogs/${blog.handle}/${article.handle}`, { snapshot });
  const missing = result.diagnostics
    .filter((d) => d.code === "missing-resource")
    .map((d) => d.message);
  assert.ok(
    missing.some((m) => m.includes("article.comments")),
    missing.join("\n"),
  );
  assert.ok(
    missing.some((m) => m.includes("blog.moderated?")),
    missing.join("\n"),
  );
});
