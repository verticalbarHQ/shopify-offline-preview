import {
  type Context,
  Hash,
  type Liquid,
  type Parser,
  Tag,
  type TagToken,
  type Template,
  type TopLevelToken,
  toPromise,
  type ValueToken,
} from "liquidjs";
import { liquidObjectKind, preserveLiquidObjectKind } from "../../data/src/objects.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
function body(parser: Parser, tokens: TopLevelToken[], name: string): Template[] {
  const templates: Template[] = [];
  let closed = false;
  parser
    .parseStream(tokens)
    .on(`tag:end${name}`, function () {
      closed = true;
      this.stop();
    })
    .on<Template>("template", (t) => templates.push(t))
    .start();
  if (!closed) throw new Error(`Unclosed ${name} tag`);
  return templates;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
interface TagHooks {
  path: string;
  unsupported(message: string): void;
  paginationOverlay?(original: Record<string, unknown>, overlay: Record<string, unknown>): void;
}
export function registerShopifyTags(engine: Liquid, hooks: TagHooks): void {
  engine.registerTag(
    "form",
    class extends Tag {
      private readonly kind: ValueToken;
      private readonly resource: ValueToken | undefined;
      private readonly hash: Hash;
      private readonly templates: Template[];
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
        super(token, tokens, liquid);
        const kind = this.tokenizer.readValue();
        if (!kind) throw new Error("Form type required");
        this.kind = kind;
        this.tokenizer.skipBlank();
        if (this.tokenizer.peek() === ",") {
          this.tokenizer.advance();
          this.tokenizer.skipBlank();
          const position = this.tokenizer.p;
          const candidate = this.tokenizer.readValue();
          this.tokenizer.skipBlank();
          if (this.tokenizer.peek() === ":") this.tokenizer.p = position;
          else this.resource = candidate;
        }
        this.hash = new Hash(this.tokenizer);
        this.templates = body(parser, tokens, "form");
      }
      async render(context: Context): Promise<string> {
        const kind = String(await engine.evalValue(this.kind.getText(), context));
        const target = this.resource
          ? await engine.evalValue(this.resource.getText(), context)
          : null;
        const resourceId = record(target) ? target.id : undefined;
        const configuration: Record<
          string,
          { action: string; id: string; class?: string; multipart?: boolean }
        > = {
          product: {
            action: "/cart/add",
            id: `product_form_${resourceId ?? ""}`,
            class: "shopify-product-form",
            multipart: true,
          },
          contact: { action: "/contact", id: "contact_form", class: "contact-form" },
          customer: { action: "/contact", id: "contact_form", class: "contact-form" },
          localization: {
            action: "/localization",
            id: "localization_form",
            class: "shopify-localization-form",
            multipart: true,
          },
        };
        const config = configuration[kind];
        if (!config) {
          hooks.unsupported(`Form type ${kind} is not implemented.`);
          return `[not implemented: form ${escapeHtml(kind)}]`;
        }
        const args: Record<string, unknown> = await toPromise(this.hash.render(context));
        const id = args.id ?? config.id;
        const action =
          kind === "contact" || kind === "customer" ? `${config.action}#${id}` : config.action;
        const attributes: Record<string, unknown> = {
          method: "post",
          action,
          id,
          "accept-charset": "UTF-8",
          ...(config.class ? { class: config.class } : {}),
          ...(config.multipart ? { enctype: "multipart/form-data" } : {}),
        };
        for (const [key, value] of Object.entries(args))
          if (key !== "return_to") {
            if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(key))
              throw new Error("Invalid form attribute name");
            attributes[key] = value;
          }
        const hidden = (name: string, value: unknown) =>
          `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;
        let before = hidden("form_type", kind) + hidden("utf8", "✓");
        if (kind === "localization")
          before +=
            hidden("_method", "put") +
            hidden(
              "return_to",
              args.return_to === true || args.return_to === undefined ? hooks.path : args.return_to,
            );
        else if (args.return_to !== undefined)
          before += hidden("return_to", args.return_to === true ? hooks.path : args.return_to);
        context.push({ form: { errors: null, "posted_successfully?": false, email: null } });
        let output: string;
        try {
          output = await engine.render(this.templates, context);
        } finally {
          context.pop();
        }
        const after = kind === "product" ? hidden("product-id", resourceId) : "";
        return `<form ${Object.entries(attributes)
          .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
          .join(" ")}>${before}${output}${after}</form>`;
      }
    },
  );
  engine.registerTag(
    "paginate",
    class extends Tag {
      private readonly array: ValueToken;
      private readonly size: ValueToken;
      private readonly hash: Hash;
      private readonly templates: Template[];
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
        super(token, tokens, liquid);
        const array = this.tokenizer.readValue();
        this.tokenizer.skipBlank();
        if (!array || this.tokenizer.readIdentifier().getText() !== "by")
          throw new Error("Paginate requires 'array by page_size'");
        const size = this.tokenizer.readValue();
        if (!size) throw new Error("Pagination size required");
        this.array = array;
        this.size = size;
        this.hash = new Hash(this.tokenizer);
        this.templates = body(parser, tokens, "paginate");
      }
      async render(context: Context): Promise<string> {
        const path = this.array.getText();
        const array: unknown = await engine.evalValue(path, context);
        if (!Array.isArray(array)) {
          hooks.unsupported(`Pagination source ${path} is not an available array.`);
          return `[not implemented: paginate ${escapeHtml(path)}]`;
        }
        const keys = path.split(".");
        const property = keys.at(-1);
        const root = keys[0];
        const parent = await engine.evalValue(keys.slice(0, -1).join("."), context);
        const expectedKind = {
          products: "collection",
          articles: "blog",
          results: "search",
          variants: "product",
        }[property ?? ""];
        if (
          !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(path) ||
          (!/^(collection\.products|blog\.articles|search\.results|product\.variants)$/.test(
            path,
          ) &&
            (!expectedKind || liquidObjectKind(parent) !== expectedKind))
        ) {
          hooks.unsupported(`Independent pagination for ${path} is not implemented.`);
          return `[not implemented: paginate ${escapeHtml(path)}]`;
        }
        const size = Number(await engine.evalValue(this.size.getText(), context));
        if (!Number.isInteger(size) || size < 1 || size > 250)
          throw new Error("Pagination size must be from 1 to 250");
        const url = new URL(hooks.path, "https://offline.invalid");
        const query = url.searchParams.get("page");
        const page = query && /^[1-9]\d*$/.test(query) ? Number(query) : 1;
        if (!Number.isSafeInteger(page) || (page - 1) * size >= 25000)
          throw new Error("Pagination exceeds the 25,000 item limit");
        const args: Record<string, unknown> = await toPromise(this.hash.render(context));
        const window = args.window_size === undefined ? 3 : Number(args.window_size);
        if (!Number.isInteger(window) || window < 0 || window > 100)
          throw new Error("Invalid pagination window_size");
        const total = Math.min(array.length, 25000),
          pages = Math.ceil(total / size),
          offset = (page - 1) * size;
        const link = (number: number) => {
          const target = new URL(url);
          target.searchParams.set("page", String(number));
          return target.pathname + target.search;
        };
        const indices = new Set<number>([1, pages]);
        for (let i = Math.max(1, page - window); i <= Math.min(pages, page + window); i++)
          indices.add(i);
        const parts: { title: string; is_link: boolean; url: string | null }[] = [];
        let previous = 0;
        for (const index of [...indices].filter((i) => i > 0).sort((a, b) => a - b)) {
          if (index - previous === 2)
            parts.push({ title: String(index - 1), is_link: true, url: link(index - 1) });
          else if (index - previous > 2) parts.push({ title: "…", is_link: false, url: null });
          parts.push({
            title: String(index),
            is_link: index !== page,
            url: index === page ? null : link(index),
          });
          previous = index;
        }
        const paginate = {
          page_size: size,
          current_page: page,
          current_offset: offset,
          items: total,
          pages,
          page_param: "page",
          parts,
          previous: page > 1 ? { title: "Previous", is_link: true, url: link(page - 1) } : null,
          next: page < pages ? { title: "Next", is_link: true, url: link(page + 1) } : null,
        };
        if (!root || !property) throw new Error("Invalid pagination path");
        const slice = array.slice(offset, offset + size);
        let local: unknown = slice;
        for (let index = keys.length - 2; index >= 0; index--) {
          const original: unknown = await engine.evalValue(
            keys.slice(0, index + 1).join("."),
            context,
          );
          const key = keys[index + 1];
          if (!record(original) || !key) throw new Error("Pagination parent is missing");
          const replacement = local;
          const overlay = new Proxy(original, {
            getOwnPropertyDescriptor(target, property) {
              return property === key
                ? { configurable: true, enumerable: true, writable: false, value: replacement }
                : Reflect.getOwnPropertyDescriptor(target, property);
            },
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver);
              return property === key ? replacement : value;
            },
          });
          preserveLiquidObjectKind(original, overlay);
          hooks.paginationOverlay?.(original, overlay);
          local = overlay;
        }
        context.push({ paginate, [root]: local });
        try {
          return await engine.render(this.templates, context);
        } finally {
          context.pop();
        }
      }
    },
  );
}
