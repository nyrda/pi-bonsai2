import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DecodeTiming {
  predicted_per_second: number;
  predicted_n: number;
}

/** Observe SSE timing fields without changing the bytes consumed by Pi. */
export function timingFetch(fetcher: typeof fetch, report: (timing: DecodeTiming) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    const decoder = new TextDecoder();
    let pending = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trimEnd();
          pending = pending.slice(end + 1);
          if (!line.startsWith("data:")) continue;
          let data;
          try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const timing = data?.timings;
          if (Number.isFinite(timing?.predicted_per_second) && timing.predicted_per_second > 0 &&
              Number.isInteger(timing.predicted_n) && timing.predicted_n > 0) {
            report(timing);
          }
        }
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export default function generationSpeed(pi: ExtensionAPI) {
  let latest: DecodeTiming | undefined;
  let setStatus: ((text: string | undefined) => void) | undefined;
  let lastPaint = 0;
  const label = () => latest
    ? `Bonsai ${latest.predicted_per_second.toFixed(1)} tok/s · ${latest.predicted_n} tokens`
    : undefined;

  pi.on("session_start", (_event, ctx) => {
    setStatus = (text) => ctx.ui.setStatus("bonsai2-speed", text);
    latest = undefined;
    setStatus(undefined);
  });
  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.model?.provider !== "bonsai2") return;
    latest = undefined;
    lastPaint = 0;
    setStatus?.("Bonsai processing prompt…");
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || event.message.provider !== "bonsai2") return;
    const stopped = event.message.stopReason === "error" || event.message.stopReason === "aborted";
    setStatus?.(stopped ? undefined : label());
  });

  return (fetcher: typeof fetch) => timingFetch(fetcher, (timing) => {
    latest = timing;
    const now = performance.now();
    if (now - lastPaint >= 250) {
      lastPaint = now;
      setStatus?.(label());
    }
  });
}
