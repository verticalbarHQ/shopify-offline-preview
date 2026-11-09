import assert from "node:assert/strict";
import { test } from "node:test";
import { RenderClock } from "../packages/render/src/render-clock.js";

test("I/O waits suspend the render's active budget once across overlapping reads", async () => {
  let now = 0,
    releaseA: (() => void) | undefined,
    releaseB: (() => void) | undefined;
  const clock = new RenderClock(undefined, () => now, 10, 120_000);
  try {
    const a = clock.io(
      () =>
        new Promise<void>((resolve) => {
          releaseA = resolve;
        }),
    );
    now = 100;
    const b = clock.io(
      () =>
        new Promise<void>((resolve) => {
          releaseB = resolve;
        }),
    );
    now = 1000;
    releaseA?.();
    await a;
    now = 2000;
    releaseB?.();
    await b;
    now = 2009;
    clock.limiter.check(now);
    now = 2011;
    assert.throws(
      () => clock.limiter.check(now),
      (error) =>
        error instanceof Error && "code" in error && error.code === "PREVIEW_RENDER_TIMEOUT",
    );
  } finally {
    clock.dispose();
  }
});

test("wall budget remains bounded while all active time is suspended", async () => {
  let now = 0,
    release: (() => void) | undefined;
  const clock = new RenderClock(undefined, () => now, 10, 120_000);
  try {
    const waiting = clock.io(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    now = 120_001;
    assert.throws(
      () => clock.limiter.check(now),
      (error) =>
        error instanceof Error && "code" in error && error.code === "PREVIEW_RENDER_TIMEOUT",
    );
    release?.();
    await waiting;
  } finally {
    clock.dispose();
  }
});
