import type { Snapshot } from "../packages/data/src/schema.js";

export function theme(): Record<string, string> {
  return {
    "layout/theme.liquid": "<html>{% sections 'header-group' %}{{ content_for_layout }}</html>",
    "sections/header-group.json": JSON.stringify({
      sections: { header: { type: "header" } },
      order: ["header"],
    }),
    "sections/header.liquid": "{{ shop.name | escape }}",
    "templates/product.json":
      "/* Shopify generated comment */\n" +
      JSON.stringify({
        sections: {
          main: { type: "product", blocks: { cta: { type: "button" } } },
          disabled: { type: "unused", disabled: true },
        },
        order: ["main", "disabled"],
      }),
    "sections/product.liquid":
      '{% liquid\n assign p = product\n echo p.title | escape\n%}{% render \'card\', product: product %}{% content_for \'blocks\' %}{% schema %}{"blocks":[{"type":"@theme"}]}{% endschema %}',
    "snippets/card.liquid":
      "{% for variant in product.variants %}{{ variant.price | money }}{% endfor %}",
    "blocks/button.liquid": "{{ block.id }}{% content_for 'block', type: 'icon', id: 'icon' %}",
    "blocks/icon.liquid": "{{ 'icon' | t }}",
    "sections/unused.liquid": "{{ product.title | never_reachable }}",
    "snippets/unreachable.liquid": "{{ product.title | also_unreachable }}",
  };
}

export function snapshot(): Snapshot {
  return {
    meta: { now: "2026-10-13T00:00:00Z", schemaVersion: "1.0" },
    shop: {
      name: "Example",
      domain: "example.test",
      locale: "en",
      currency: "USD",
      money_format: "USD {{amount}}",
      money_with_currency_format: "USD {{amount}}",
      timezone: "UTC",
    },
    products: [],
    collections: [],
    pages: [],
    blogs: [],
    menus: [],
    metaobjects: [],
    cart: { lines: [], note: "" },
    filters: [],
    scenarios: {},
  };
}
