import { Context, type Scope } from "liquidjs";
import { SourceDictionary } from "../../data/src/source-objects.js";
import { LiquidRange } from "./range-values.js";

/** JSON object keys remain scalar keys; a range must not alias its display text. */
export class PreviewContext extends Context {
  override *_getFromScope(
    scope: unknown,
    paths: Parameters<Context["_getFromScope"]>[1],
    strictVariables?: boolean,
  ): IterableIterator<unknown> {
    const resolved = yield scope;
    return yield* super._getFromScope(resolved, paths, strictVariables);
  }
  override readProperty(object: Scope, key: Parameters<Context["readProperty"]>[1]): unknown {
    if (key instanceof LiquidRange) return undefined;
    if (object instanceof SourceDictionary) {
      // Paginate overlays a captured member as an own property on the dictionary.
      if (
        !["lookup", "enumerate", "count", "list"].includes(String(key)) &&
        Object.hasOwn(object, String(key))
      )
        return Reflect.get(object, String(key));
      return object.liquidMethodMissing(String(key));
    }
    return super.readProperty(object, key);
  }
  override spawn(scope = {}): PreviewContext {
    return new PreviewContext(
      scope,
      this.opts,
      {
        sync: this.sync,
        globals: this.globals,
        strictVariables: this.strictVariables,
        ownPropertyOnly: this.ownPropertyOnly,
      },
      {
        memoryLimit: this.memoryLimit,
        renderLimit: this.renderLimit,
        liquid: this.liquid,
      },
    );
  }
}
