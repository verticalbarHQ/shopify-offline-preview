import {
  type Context,
  Drop,
  type Emitter,
  evalTokenValue,
  type Liquid,
  TablerowTag,
  type TagToken,
  toPromise,
  toValue,
} from "liquidjs";

interface Cursor {
  index: number;
}
export class TableRowLoop extends Drop {
  readonly #cursor: Cursor;
  readonly #columns: number;
  constructor(
    readonly length: number,
    columns: number,
    cursor: Cursor,
  ) {
    super();
    this.#columns = columns;
    this.#cursor = cursor;
  }
  index0() {
    return this.#cursor.index;
  }
  index() {
    return this.index0() + 1;
  }
  first() {
    return this.index0() === 0;
  }
  last() {
    return this.index() === this.length;
  }
  rindex() {
    return this.length - this.index0();
  }
  rindex0() {
    return this.rindex() - 1;
  }
  row() {
    return this.#columns > 0 ? Math.floor(this.index0() / this.#columns) + 1 : 1;
  }
  col0() {
    return this.#columns > 0 ? this.index0() % this.#columns : this.index0();
  }
  col() {
    return this.col0() + 1;
  }
  col_first() {
    return this.col0() === 0;
  }
  col_last() {
    return this.#columns > 0 && this.col() === this.#columns;
  }
  valueOf() {
    return "Liquid::TablerowloopDrop";
  }
}
function integer(input: unknown): number {
  const value: unknown = toValue(input);
  if (value === null || value === undefined) return 0;
  if (typeof value === "number" || value instanceof Number) {
    if (!Number.isFinite(Number(value))) throw new Error("invalid integer");
    return Math.trunc(Number(value));
  }
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  throw new Error("invalid integer");
}
function iterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, Symbol.iterator) === "function"
  );
}
function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value ? [value] : [];
  if (iterable(value)) return Array.from(value);
  return value !== null && typeof value === "object" ? Object.entries(value) : [];
}
export function registerTableRowTag(
  engine: Liquid,
  execute: (value: unknown, token: TagToken, render: () => Promise<string>) => Promise<string>,
  onError: (error: unknown, token: TagToken) => string,
): void {
  engine.registerTag(
    "tablerow",
    class extends TablerowTag {
      *render(context: Context, emitter: Emitter) {
        yield this.#render(context, emitter);
      }
      async #render(context: Context, emitter: Emitter): Promise<void> {
        try {
          await this.#run(context, emitter);
        } catch (error) {
          emitter.write(onError(error, this.token));
        }
      }
      async #run(context: Context, emitter: Emitter): Promise<void> {
        const value: unknown = await toPromise(evalTokenValue(this.collection, context));
        if (value === null || value === undefined || value === false) return;
        const all = collection(value);
        context.memoryLimit.use(all.length);
        const args = await toPromise(this.args.render(context));
        const from = Object.hasOwn(args, "offset") ? integer(args.offset) : 0;
        const end = Object.hasOwn(args, "limit") ? from + integer(args.limit) : all.length;
        const items = all.slice(Math.max(0, from), Math.max(0, end));
        const cols = Object.hasOwn(args, "cols") ? integer(args.cols) : items.length;
        const cursor: Cursor = { index: 0 };
        const loop = new TableRowLoop(items.length, cols, cursor);
        const scope: Record<string, unknown> = Object.assign(Object.create(null), {
          tablerowloop: loop,
        });
        emitter.write('<tr class="row1">\n');
        context.push(scope);
        try {
          for (const item of items) {
            context.renderLimit.use(1);
            context.breakCalled = context.continueCalled = false;
            scope[this.variable] = item;
            emitter.write(`<td class="col${loop.col()}">`);
            emitter.write(
              await execute(item, this.token, () => engine.render(this.templates, context)),
            );
            emitter.write("</td>");
            if (context.breakCalled) break;
            if (loop.col_last() && !loop.last())
              emitter.write(`</tr>\n<tr class="row${loop.row() + 1}">`);
            cursor.index++;
          }
        } finally {
          context.breakCalled = context.continueCalled = false;
          context.pop();
        }
        emitter.write("</tr>\n");
      }
    },
  );
}
