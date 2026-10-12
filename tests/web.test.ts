import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";

// Pi supplies TypeBox at runtime; the tools only pass its schemas through. The HTML libraries
// come from pi/node_modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "typebox") {
      return { url: "data:text/javascript,export const Type = new Proxy({}, { get: () => (...args) => args });", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { default: webTools, htmlToMarkdown, formatSearch } = await import("../pi/web.ts");

const singleLine = "x".repeat(60_000);
const longText = Array.from({ length: 4000 }, (_, i) => `line ${i} of the long page`).join("\n");
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost");
  if (url.pathname === "/searx/search") {
    assert.equal(url.searchParams.get("format"), "json");
    if (url.searchParams.get("q") === "blocked") { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      answers: [{ answer: "42", url: "https://example.org/answer" }],
      results: Array.from({ length: 12 }, (_, i) => ({
        title: `Result ${i}`, url: `https://example.org/${i}`, content: `Snippet  ${i}`,
      })),
      suggestions: ["related"],
    }));
  } else if (url.pathname === "/page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>Caf&eacute; &amp; Co</title><script>alert(1)</script></head><body>
      <nav><a href="/home">Home</a></nav>
      <main><h2>Menu</h2><p>Hot&nbsp;drinks &#8212; see <a href="/drinks">the list</a>.</p>
      <ul><li>Tea</li><li><p>Coffee</p></li></ul><pre><code>x  =  1\n  y</code></pre></main>
      <footer>Footer</footer></body></html>`);
  } else if (url.pathname === "/long") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(longText);
  } else if (url.pathname === "/single-line") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(singleLine);
  } else if (url.pathname === "/legacy") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>Caf'), Buffer.from([0xe9]), Buffer.from("</p></body></html>")]));
  } else if (url.pathname === "/fragment") {
    res.end("<body><p>Plain <b>fragment</b></p></body>");
  } else if (url.pathname === "/huge") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><article>" + "<p>Lorem ipsum <a href='/x'>dolor</a> sit amet.</p>".repeat(30_000) + "</article></body></html>");
  } else if (url.pathname === "/svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end("<svg/>");
  } else if (url.pathname === "/image") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.alloc(16));
  } else { res.writeHead(404); res.end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => new Promise<void>(resolve => server.close(() => resolve())));

function setup(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  const tools: Record<string, any> = {};
  const events: Record<string, Function> = {};
  try {
    webTools({
      on(name: string, handler: Function) { events[name] = handler; },
      registerTool(tool: any) { tools[tool.name] = tool; },
    } as any);
  } finally { process.env = saved; }
  return { tools, events };
}
const text = (result: any) => result.content[0].text as string;

test("search is offered only with a configured instance, and BONSAI_WEB=0 disables both tools", () => {
  assert.deepEqual(Object.keys(setup({ BONSAI_SEARXNG_URL: undefined, BONSAI_WEB: undefined }).tools), ["web_fetch"]);
  assert.deepEqual(Object.keys(setup({ BONSAI_SEARXNG_URL: origin, BONSAI_WEB: "0" }).tools), []);
});

test("web_search formats SearXNG results and explains a disabled JSON format", async () => {
  const { tools } = setup({ BONSAI_SEARXNG_URL: `${origin}/searx`, BONSAI_WEB: undefined });
  const output = text(await tools.web_search.execute("1", { query: "coffee" }));
  assert.match(output, /^Answer: 42 \(https:\/\/example.org\/answer\)/);
  assert.match(output, /1\. Result 0\n {3}https:\/\/example.org\/0\n {3}Snippet 0/);
  assert.match(output, /8\. Result 7/);
  assert.doesNotMatch(output, /Result 8/);
  assert.match(output, /Suggestions: related/);
  await assert.rejects(tools.web_search.execute("2", { query: "blocked" }), /search\.formats/);
});

test("web_fetch converts HTML to readable text with absolute links", async () => {
  const { tools } = setup({ BONSAI_WEB: undefined });
  const output = text(await tools.web_fetch.execute("1", { url: `${origin}/page` }));
  assert.match(output, /^URL: http:\/\/127\.0\.0\.1:\d+\/page\nTitle: Café & Co\n/);
  assert.match(output, /## Menu\n\nHot\s+drinks — see \[the list\]\(http:\/\/127\.0\.0\.1:\d+\/drinks\)\./);
  assert.match(output, /- +Tea\n- +Coffee/);
  assert.match(output, /```\nx {2}= {2}1\n {2}y\n```/);
  assert.doesNotMatch(output, /alert|Home|Footer/);
});

test("web_fetch saves long pages for reading and removes them at shutdown", async () => {
  const { tools, events } = setup({ BONSAI_WEB: undefined });
  const result = await tools.web_fetch.execute("1", { url: `${origin}/long` });
  const path = result.details.fullOutputPath;
  assert.ok(text(result).length < 41_000);
  const offset = Number(/offset (\d+)/.exec(text(result))![1]);
  const lastShown = /line (\d+) of the long page\n\n\[Showing/.exec(text(result))![1];
  assert.equal(readFileSync(path, "utf8").split("\n")[offset - 1], `line ${Number(lastShown) + 1} of the long page`);
  await events.session_shutdown({});
  assert.equal(existsSync(path), false);
});

test("web_fetch resumes a line cut in the middle instead of skipping it", async () => {
  const { tools } = setup({ BONSAI_WEB: undefined });
  const result = await tools.web_fetch.execute("1", { url: `${origin}/single-line` });
  const offset = Number(/offset (\d+)/.exec(text(result))![1]);
  assert.equal(readFileSync(result.details.fullOutputPath, "utf8").split("\n")[offset - 1], singleLine);
});

test("web_fetch honors a <meta> charset and converts HTML sent without a content type", async () => {
  const { tools } = setup({ BONSAI_WEB: undefined });
  assert.match(text(await tools.web_fetch.execute("1", { url: `${origin}/legacy` })), /\n\nCafé$/);
  assert.match(text(await tools.web_fetch.execute("2", { url: `${origin}/fragment` })), /\n\nPlain \*\*fragment\*\*$/);
});

test("web_fetch rejects non-HTTP URLs, HTTP errors, and binary content", async () => {
  const { tools } = setup({ BONSAI_WEB: undefined });
  await assert.rejects(tools.web_fetch.execute("1", { url: "file:///etc/passwd" }), /Only http/);
  await assert.rejects(tools.web_fetch.execute("2", { url: `${origin}/missing` }), /HTTP 404/);
  await assert.rejects(tools.web_fetch.execute("3", { url: `${origin}/image` }), /Unsupported content type image\/png/);
  await assert.rejects(tools.web_fetch.execute("4", { url: `${origin}/svg` }), /Unsupported content type image\/svg\+xml/);
});

test("web_fetch converts only the first MiB of a huge page", async () => {
  const { tools } = setup({ BONSAI_WEB: undefined });
  const started = performance.now();
  const output = text(await tools.web_fetch.execute("1", { url: `${origin}/huge` }));
  assert.ok(performance.now() - started < 10_000);
  assert.match(output, /\[Converted only the first 1 MiB of HTML\.\]$/);
});

test("formatSearch clips long fields from the instance", () => {
  const output = formatSearch("q", {
    answers: Array(10).fill("a".repeat(5000)),
    results: [{ title: "t".repeat(5000), url: "https://x.test/", content: "c".repeat(50_000) }],
  });
  assert.ok(output.length < 3000);
});

test("htmlToMarkdown keeps the article with absolute links, tables, and code", async () => {
  const html = '<html><head><title>Guide</title><base href="/docs/"></head><body><nav>Menu</nav><article>' +
    '<h2>Setup</h2><p>Read <a href="intro" title="Intro page">the intro</a> or <a href="javascript:x()">this</a>. ' +
    "Long enough text. ".repeat(40) + '<a href="/home"><img src="/logo.png" alt="Logo"></a></p>' +
    "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>" +
    "<pre>x = 1\n\n\n  y</pre><pre><code>let z = 1;</code></pre></article><footer>Footer</footer><script>evil()</script></body></html>";
  const { title, text } = await htmlToMarkdown(html, "https://x.test/app/index.html");
  assert.equal(title, "Guide");
  assert.match(text, /^## Setup\n\nRead \[the intro\]\(https:\/\/x\.test\/docs\/intro\) or this\./);
  assert.match(text, /\[Logo\]\(https:\/\/x\.test\/home\)\n\n\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(text, /\n```\nx = 1\n\n\n  y\n```\n\n```\nlet z = 1;\n```$/);
  assert.doesNotMatch(text, /Menu|Footer|evil|logo\.png|Intro page|javascript/);
});

test("htmlToMarkdown converts fragments and leaves out hidden elements", async () => {
  const html = '<p>Use <code>Array&lt;string&gt;</code></p><div hidden>stale</div>';
  assert.deepEqual(await htmlToMarkdown(html, "https://x.test/"), { title: "", text: "Use `Array<string>`" });
});
