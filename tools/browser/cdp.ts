import { z } from "zod";

const protocolSchema = z.object({
  id: z.number().optional(),
  sessionId: z.string().optional(),
  method: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string() }).optional(),
});
type Protocol = z.infer<typeof protocolSchema>;
/** Test-only CDP transport, scoped to the explicitly selected agent-browser session. */
export class BrowserProtocol {
  private serial = 0;
  private readonly waiting = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly observers = new Set<(event: Protocol) => void>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = protocolSchema.parse(JSON.parse(String(event.data)));
      if (message.id !== undefined) {
        const pending = this.waiting.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.waiting.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
      } else for (const observer of this.observers) observer(message);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.waiting.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Browser connection closed"));
      }
      this.waiting.clear();
    });
  }
  static async connect(endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname))
      throw new Error("Browser tests require a loopback CDP endpoint");
    const socket = new WebSocket(endpoint);
    const client = new BrowserProtocol(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Browser connection failed")), {
        once: true,
      });
    });
    return client;
  }
  call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 15000);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(callback: (event: Protocol) => void) {
    this.observers.add(callback);
    return () => this.observers.delete(callback);
  }
  async evaluate(sessionId: string, expression: string, contextId?: number): Promise<unknown> {
    const response = await this.call(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId !== undefined ? { contextId } : {}),
      },
      sessionId,
    );
    if (response.exceptionDetails)
      throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    const result = z.object({ value: z.unknown().optional() }).parse(response.result);
    return result.value;
  }
  close() {
    this.socket.close();
  }
}
