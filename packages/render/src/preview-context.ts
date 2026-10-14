import { Context, type Scope, toValue } from "liquidjs";
import { LiquidRange } from "./range-values.js";

/** JSON object keys remain scalar keys; a range must not alias its display text. */
export class PreviewContext extends Context {
  override readProperty(object: Scope, key: Parameters<Context["readProperty"]>[1]): unknown {
    if (toValue(key) instanceof LiquidRange) return undefined;
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
