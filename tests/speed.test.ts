import { test } from "node:test";
import assert from "node:assert/strict";
import generationSpeed, { timingFetch } from "../pi/speed.ts";

test("observes fragmented SSE timings and preserves every byte", async () => {
  const wire = 'data: {"choices":[{"delta":{"content":"é"}}],"timings":{"predicted_n":12,"predicted_per_second":37.8}}\r\n\r\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(wire);
  const seen: unknown[] = [];
  const fakeFetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
  const response = await timingFetch(fakeFetch, t => seen.push(t))("http://localhost");
  assert.equal(await response.text(), wire);
  assert.deepEqual(seen, [{ predicted_n: 12, predicted_per_second: 37.8 }]);
});

test("does not alter errors or non-stream responses", async () => {
  const response = new Response('{"error":"busy"}', { status: 503 });
  assert.equal(await timingFetch(async () => response, () => assert.fail())("http://localhost"), response);
});

test("footer updates live, keeps final rate, resets on next request and abort", async () => {
  const handlers: Record<string, Function> = {};
  const statuses: unknown[] = [];
  const wrap = generationSpeed({ on: (name, handler) => { handlers[name] = handler; } } as any);
  const ctx = { model: { provider: "bonsai2" }, ui: { setStatus: (_key, text) => statuses.push(text) } };
  handlers.session_start({}, ctx);
  handlers.before_provider_request({}, ctx);
  assert.equal(statuses.at(-1), "Bonsai processing prompt…");
  await new Promise(resolve => setTimeout(resolve, 260));
  const response = await wrap(async () => new Response(
    'data: {"timings":{"predicted_n":100,"predicted_per_second":42.5}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ))("http://localhost");
  await response.text();
  assert.equal(statuses.at(-1), "Bonsai 42.5 tok/s · 100 tokens");
  handlers.message_end({ message: { role: "assistant", provider: "bonsai2", stopReason: "stop" } });
  assert.equal(statuses.at(-1), "Bonsai 42.5 tok/s · 100 tokens");
  handlers.before_provider_request({}, ctx);
  handlers.message_end({ message: { role: "assistant", provider: "bonsai2", stopReason: "aborted" } });
  assert.equal(statuses.at(-1), undefined);
});
