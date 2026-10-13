import type { RenderResult } from "../../render/src/contracts.js";
export interface PreviewInput {
  path: string;
  scenario: string;
  designMode: boolean;
}
export interface InspectorConfiguration {
  previewOrigin: string;
  scenarios: string[];
  scenario?: string;
  designMode?: boolean;
}
export interface InspectorTransport {
  config(): Promise<InspectorConfiguration>;
  render(input: PreviewInput, signal: AbortSignal): Promise<unknown>;
  source(file: string): Promise<string>;
  preview(
    frame: HTMLIFrameElement,
    result: RenderResult,
    input: PreviewInput,
    viewId: string,
    signal: AbortSignal,
  ): Promise<void>;
  subscribe(changed: () => void, unavailable: () => void): void;
}
declare global {
  interface Window {
    SOP_INSPECTOR_TRANSPORT?: InspectorTransport;
  }
}
export const localTransport: InspectorTransport = {
  async config() {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`Configuration returned ${response.status}`);
    return response.json();
  },
  async render(input, signal) {
    const query = new URLSearchParams({
      path: input.path,
      scenario: input.scenario,
      designMode: String(input.designMode),
    });
    const response = await fetch(`/api/render?${query}`, { signal });
    if (!response.ok) {
      const body: unknown = await response.json();
      throw new Error(
        body && typeof body === "object" && "error" in body
          ? String(body.error)
          : `Render returned ${response.status}`,
      );
    }
    return response.json();
  },
  async source(file) {
    const response = await fetch(`/api/source?file=${encodeURIComponent(file)}`);
    if (!response.ok) throw new Error(`Source returned ${response.status}`);
    return response.text();
  },
  async preview(frame, result, input, viewId, signal) {
    const config = await this.config();
    const url = new URL(result.route.path, config.previewOrigin);
    url.searchParams.set("__sop_scenario", input.scenario);
    url.searchParams.set("__sop_design_mode", String(input.designMode));
    url.searchParams.set("__sop_route", result.route.path);
    url.searchParams.set("__sop_view", viewId);
    if (signal.aborted) return;
    frame.removeAttribute("srcdoc");
    frame.src = url.href;
  },
  subscribe(changed, unavailable) {
    const events = new EventSource("/events");
    events.addEventListener("changed", changed);
    events.addEventListener("error", unavailable);
  },
};
