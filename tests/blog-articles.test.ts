import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("a blog lists its articles newest first, the later-created first on equal times", async () => {
  const snapshot = defaultFixture();
  const blog = snapshot.blogs[0];
  assert.ok(blog);
  const [one, two, three] = blog.articles;
  assert.ok(one && two && three);
  // Source order 1, 2, 3; story 2 is the newest, stories 1 and 3 were published together.
  blog.articles = [
    { ...one, id: "11", publishedAt: "2026-10-01T00:00:00Z" },
    { ...two, id: "12", publishedAt: "2026-10-05T00:00:00Z" },
    { ...three, id: "13", publishedAt: "2026-10-01T00:00:00Z" },
  ];
  const theme = new MemoryThemeFileSystem({
    "templates/blog.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid":
      "{% for a in blog.articles %}{{ a.handle }} {% endfor %}|{{ blogs.news.articles.first.handle }}",
  });
  const result = await renderTheme(theme, "/blogs/news", { snapshot });
  assert.ok(result.html.includes("story-2 story-3 story-1 |story-2"), result.html);
});
