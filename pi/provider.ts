import { readFileSync } from "node:fs";
import { request } from "node:http";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import generationSpeed from "./speed.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const withTimings = generationSpeed(pi);
  const variant = process.env.BONSAI_VARIANT || "abliterated-mtp";
  const registry: Record<string, { label: string; vision: boolean; runtime?: string }> = JSON.parse(
    readFileSync(new URL("./variants.json", import.meta.url), "utf8"),
  );
  const available = Object.entries(registry).filter(([id]) =>
    process.env.BONSAI_BASE_URL && !process.env.BONSAI_CONTROL_URL
      ? id === variant
      : true,
  );
  let activeVariant = variant;
  let switching: Promise<void> | undefined;
  async function switchVariant(selected: string) {
    if (!available.some(([id]) => id === selected)) throw new Error(`Unknown Bonsai variant: ${selected}`);
    if (switching) await switching;
    if (selected === activeVariant) return;
    if (!process.env.BONSAI_CONTROL_URL) throw new Error("Switch the external server separately, then restart Pi with --variant.");
    switching = (async () => {
      // Downloads can exceed fetch's default response-header timeout.
      await new Promise<void>((resolve, reject) => {
        const body = JSON.stringify({ variant: selected });
        const req = request(`${process.env.BONSAI_CONTROL_URL}/switch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${process.env.BONSAI_API_KEY}`,
          },
        }, (response) => {
          let data = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { data += chunk; });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const result = JSON.parse(data);
              if (response.statusCode !== 200) throw new Error(result.error || "Model switch failed");
              resolve();
            } catch (error) { reject(error); }
          });
        });
        req.setTimeout(3_900_000, () => req.destroy(new Error("Model switch timed out")));
        req.on("error", reject);
        req.end(body);
      });
      activeVariant = selected;
    })();
    try { await switching; } finally { switching = undefined; }
  }
  pi.registerCommand("bonsai-model", {
    description: "Switch the local Bonsai model, downloading pinned weights if needed",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current response to finish.", "warning"); return; }
      if (!process.env.BONSAI_CONTROL_URL) { ctx.ui.notify("Model switching requires a Pi-managed backend.", "warning"); return; }
      const choices = available.map(([id, entry]) => ({
        id, text: `${entry.label} · ${id}${id === activeVariant ? " · current" : ""}`,
      }));
      const picked = args.trim() ? undefined : await ctx.ui.select("Bonsai model", choices.map(c => c.text));
      const selected = args.trim() || choices.find(c => c.text === picked)?.id;
      if (!selected) return;
      const started = Date.now();
      let stopped = false;
      let polling = false;
      const updateStatus = async () => {
        if (polling || stopped) return;
        polling = true;
        try {
          const response = await fetch(`${process.env.BONSAI_CONTROL_URL}/status`, {
            headers: { Authorization: `Bearer ${process.env.BONSAI_API_KEY}` },
            signal: AbortSignal.timeout(2000),
          });
          if (!response.ok) return;
          const status = await response.json() as { phase: string; elapsed: number };
          if (!stopped) ctx.ui.setStatus("bonsai2-switch", `${status.phase} · ${status.elapsed}s`);
        } catch {
          if (!stopped) ctx.ui.setStatus("bonsai2-switch", `Preparing ${selected} · ${Math.floor((Date.now() - started) / 1000)}s`);
        } finally { polling = false; }
      };
      ctx.ui.setStatus("bonsai2-switch", `Preparing ${selected}…`);
      const timer = setInterval(updateStatus, 1000);
      try {
        await switchVariant(selected);
        const model = ctx.modelRegistry.find("bonsai2", `bonsai2-${selected}`);
        if (!model || !await pi.setModel(model)) throw new Error("Could not select the model in Pi");
        ctx.ui.notify(`Using ${registry[selected].label}`, "info");
      } catch (error) { ctx.ui.notify(String(error), "error"); }
      finally { stopped = true; clearInterval(timer); ctx.ui.setStatus("bonsai2-switch", undefined); }
    },
  });
  const contextWindow = Number(process.env.BONSAI_CTX || 131072);
  pi.registerProvider("bonsai2", {
    baseUrl: process.env.BONSAI_BASE_URL || "http://127.0.0.1:28743/v1",
    apiKey: process.env.BONSAI_API_KEY || "local",
    api: "openai-completions",
    streamSimple: (model, context, options) => streamCompletions(
      { ...model, api: "openai-completions" }, context,
      { ...options, fetch: withTimings(options?.fetch ?? globalThis.fetch) },
    ),
    models: available.map(([id, entry]) => ({
      id: `bonsai2-${id}`,
      name: entry.label,
      reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: null },
      input: process.env.BONSAI_VISION === "0" || !entry.vision ? ["text"] : ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(8192, Math.floor(contextWindow / 2)),
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        thinkingTokenBudgetField: "thinking_budget_tokens",
        supportsStrictMode: false,
      },
    })),
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (ctx.model?.provider !== "bonsai2") return;
    await switchVariant(ctx.model.id.replace(/^bonsai2-/, ""));
    const payload = event.payload as Record<string, unknown>;
    const thinking = payload.reasoning_effort !== "none";
    return {
      ...payload,
      timings_per_token: true,
      temperature: thinking ? 1.0 : 0.7,
      top_p: thinking ? 0.95 : 0.8,
      top_k: 20,
      min_p: 0,
      presence_penalty: thinking ? 0 : 1.5,
      repeat_penalty: 1.0,
    };
  });
}
