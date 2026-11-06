import assert from "node:assert/strict";
import { test } from "node:test";
import { Token, Tokenizer } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { tokenLine } from "../packages/render/src/token-line.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

// 11-06: the renderer asked liquidjs for the line of every tag it rendered and every filter it called, and
// Token.getPosition counts the template's newlines from its start each time: quadratic on a large template.

test("a token's line is the line liquidjs gives it, for every token of a template", () => {
  const templates = [
    "",
    "{{ a }}",
    "\n\n{{ a }}",
    "{% if a %}\n  {{ a | upcase }}\n{% endif %}\n",
    "line one\r\nline two {{ b }}\r\n\r\n{% for i in (1..3) %}{{ i }}\n{% endfor %}",
    `${"x\n".repeat(500)}{% assign y = 1 %}{{ y | plus: 1 }}\n{{ y }}`,
  ];
  for (const text of templates) {
    for (const token of new Tokenizer(text).readTopLevelTokens())
      assert.equal(tokenLine(token), token.getPosition()[0], JSON.stringify(text.slice(0, 40)));
    // any offset, as a token nested in a tag would start: 1 + the newlines before it
    for (let begin = 0; begin <= text.length; begin += 7) {
      const at = { input: text, begin, getPosition: () => [0, 0] };
      assert.equal(tokenLine(at), 1 + (text.slice(0, begin).match(/\n/g)?.length ?? 0));
    }
  }
});

test("rendering asks no token for its position from the start of its template", async () => {
  const original = Token.prototype.getPosition;
  let calls = 0;
  Token.prototype.getPosition = function (this: Token) {
    calls += 1;
    return original.call(this);
  };
  try {
    const body = `${"{% assign n = 1 %}{{ n | plus: 1 }}\n".repeat(200)}{{ 'x' | upcase }}`;
    const theme = new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{ content_for_layout }}",
      "templates/index.liquid": body,
    });
    const out = await renderTheme(theme, "/", { snapshot: defaultFixture() });
    assert.match(out.html, /X$/m);
    assert.equal(calls, 0);
  } finally {
    Token.prototype.getPosition = original;
  }
});
