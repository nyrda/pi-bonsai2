import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";

// Stub inference transport; execute the real provider and speed extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai/api/openai-completions") {
      return { url: "data:text/javascript,export const streamSimple = () => { throw Error('Unexpected inference'); };", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: provider } = await import("../pi/provider.ts");

function setup() {
  const events: Record<string, Function[]> = {};
  const commands: Record<string, any> = {};
  let config: any;
  let selected: any;
  provider({
    on(name, handler) { (events[name] ??= []).push(handler); },
    registerCommand(name, command) { commands[name] = command; },
    registerProvider(_name, value) { config = value; },
    async setModel(model) { selected = model; return true; },
  } as any);
  const notifications: any[] = [];
  const statuses: any[] = [];
  const ctx = {
    model: { provider: "bonsai2", id: "bonsai2-pq2" },
    isIdle: () => true,
    modelRegistry: { find: (_provider: string, id: string) => config.models.find((m: any) => m.id === id) },
    ui: {
      notify: (...args: any[]) => notifications.push(args),
      setStatus: (...args: any[]) => statuses.push(args),
      select: async (_title: string, choices: string[]) => choices.find(c => c.includes("Hikari")),
    },
  };
  return { config, commands, events, ctx, notifications, statuses, selected: () => selected };
}

test("provider switches models, applies sampling, and recovers from control errors", async () => {
  const env = { ...process.env };
  const calls: string[] = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body).variant);
    res.writeHead(fail ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fail ? { error: "test loading failure" } : {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    process.env.BONSAI_CONTROL_URL = `http://127.0.0.1:${(server.address() as any).port}`;
    process.env.BONSAI_API_KEY = "test-key";
    process.env.BONSAI_VARIANT = "abliterated-mtp";
    delete process.env.BONSAI_BASE_URL;
    delete process.env.BONSAI_VISION;
    const h = setup();
    assert.equal(h.config.models.length, 4);
    assert.deepEqual(h.config.models[0].input, ["text", "image"]);
    const before = h.events.before_provider_request.at(-1)!;
    const payload = await before({ payload: { reasoning_effort: "none", messages: [] } }, h.ctx);
    assert.equal(payload.temperature, 0.7);
    assert.equal(payload.top_p, 0.8);
    assert.equal(payload.timings_per_token, true);
    assert.deepEqual(calls, ["pq2"]);
    await before({ payload: { reasoning_effort: "medium" } }, h.ctx);
    assert.equal(calls.length, 1);
    fail = true;
    await h.commands["bonsai-model"].handler("ptq1", h.ctx);
    assert.match(h.notifications.at(-1)[0], /test loading failure/);
    assert.equal(h.selected(), undefined);
    fail = false;
    await h.commands["bonsai-model"].handler("", h.ctx);
    assert.equal(h.selected().id, "bonsai2-abliterated-pq2");
    assert.equal(h.statuses.at(-1)[1], undefined);
    h.ctx.model.id = "bonsai2-abliterated-pq2";
    const thinking = await before({ payload: { reasoning_effort: "medium" } }, h.ctx);
    assert.equal(thinking.temperature, 1);
    assert.equal(thinking.top_p, 0.95);
    assert.deepEqual(calls, ["pq2", "ptq1", "abliterated-pq2"]);
  } finally {
    process.env = env;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("external backends expose only their model and respect text-only input", async () => {
  const env = { ...process.env };
  try {
    delete process.env.BONSAI_CONTROL_URL;
    process.env.BONSAI_BASE_URL = "http://127.0.0.1:28743/v1";
    process.env.BONSAI_VARIANT = "pq2";
    process.env.BONSAI_VISION = "0";
    const h = setup();
    assert.deepEqual(h.config.models.map((m: any) => m.id), ["bonsai2-pq2"]);
    assert.deepEqual(h.config.models[0].input, ["text"]);
    await h.commands["bonsai-model"].handler("ptq1", h.ctx);
    assert.match(h.notifications.at(-1)[0], /managed backend/);
  } finally { process.env = env; }
});
