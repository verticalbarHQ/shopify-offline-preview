import { Context } from "liquidjs";

const Limiter = new Context().renderLimit.constructor as new (
  resource: string,
  limit: number,
) => Context["renderLimit"];

import { RenderSourceError } from "../../data/src/render-source.js";

/** One render owns its wall deadline and the union (not sum) of overlapping I/O waits. */
export class RenderClock {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly started: number;
  private waiting = 0;
  private waitStart = 0;
  private paused = 0;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  readonly limiter: Context["renderLimit"];
  constructor(
    private readonly parent?: AbortSignal,
    private readonly now = () => performance.now(),
    activeMs = 10_000,
    wallMs = 120_000,
  ) {
    this.started = now();
    this.abort = () =>
      this.controller.abort(parent?.reason ?? new DOMException("Render aborted", "AbortError"));
    if (parent?.aborted) this.abort();
    else parent?.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(
      () =>
        this.controller.abort(
          new RenderSourceError(
            "PREVIEW_RENDER_TIMEOUT",
            "Preview rendering exceeded its overall time limit",
          ),
        ),
      wallMs,
    );
    const clock = this;
    this.limiter = new (class extends Limiter {
      constructor() {
        super("render", Infinity);
      }
      override check(): void {
        clock.signal.throwIfAborted();
        const current = now();
        if (current - clock.started >= wallMs)
          throw new RenderSourceError(
            "PREVIEW_RENDER_TIMEOUT",
            "Preview rendering exceeded its overall time limit",
          );
        const suspended = clock.paused + (clock.waiting > 0 ? current - clock.waitStart : 0);
        if (current - clock.started - suspended > activeMs)
          throw new RenderSourceError(
            "PREVIEW_RENDER_TIMEOUT",
            "Preview rendering exceeded its active execution time limit",
          );
      }
    })();
  }
  async io<T>(read: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    if (this.waiting++ === 0) this.waitStart = this.now();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(this.signal.reason);
          if (this.signal.aborted) abort();
          else this.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      if (error instanceof RenderSourceError) throw error;
      throw new RenderSourceError(
        "PREVIEW_SOURCE_READ_FAILED",
        error instanceof Error ? error.message : "Preview source read failed",
        { cause: error },
      );
    } finally {
      if (abort) this.signal.removeEventListener("abort", abort);
      if (--this.waiting === 0) this.paused += this.now() - this.waitStart;
    }
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.abort);
  }
}
export function fatalSourceError(error: unknown): unknown {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    if (
      current instanceof RenderSourceError ||
      (current instanceof Error && current.name === "AbortError")
    )
      return current;
    visited.add(current);
    current =
      "originalError" in current
        ? current.originalError
        : "cause" in current
          ? current.cause
          : undefined;
  }
  return undefined;
}
