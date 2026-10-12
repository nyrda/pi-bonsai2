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
    '<h2>Setup</h2><p>Read <a href="intro" title="Intro page">the intro</a> first. ' + "Long enough text. ".repeat(40) +
    '<img src="/logo.png" alt="Logo"></p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>' +
    "<pre>x = ```\n  y</pre><pre><code>let z = 1;</code></pre></article><footer>Footer</footer><script>evil()</script></body></html>";
  const { title, text } = await htmlToMarkdown(html, "https://x.test/app/index.html");
  assert.equal(title, "Guide");
  assert.match(text, /^## Setup\n\nRead \[the intro\]\(https:\/\/x\.test\/docs\/intro\) first\./);
  assert.match(text, /Logo\n\n\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.match(text, /\n````\nx = ```\n  y\n````\n\n```\nlet z = 1;\n```$/);
  assert.doesNotMatch(text, /Menu|Footer|evil|logo\.png|Intro page/);
});

test("htmlToMarkdown converts fragments and leaves out hidden elements", async () => {
  const html = '<p>Use <code>Array&lt;string&gt;</code></p><div hidden>stale</div>';
  assert.deepEqual(await htmlToMarkdown(html, "https://x.test/"), { title: "", text: "Use `Array<string>`" });
});

test("htmlToMarkdown keeps large and headerless tables as Markdown tables", async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => `<tr><td>row ${i}</td><td>${"x".repeat(20)}</td></tr>`).join("");
  const { text } = await htmlToMarkdown(`<table><tr><th>name</th><th>value</th></tr>${rows}</table>`, "https://x.test/");
  const lines = text.split("\n");
  assert.equal(lines.length, 3002);
  assert.deepEqual(lines.slice(0, 3), ["| name | value |", "| --- | --- |", `| row 0 | ${"x".repeat(20)} |`]);
  assert.equal(lines.filter(line => line.startsWith("| ---")).length, 1);
  const headerless = await htmlToMarkdown("<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>", "https://x.test/");
  assert.equal(headerless.text, "| a | b |\n| --- | --- |\n| 1 | 2 |");
});

test("htmlToMarkdown keeps code whitespace and turns non-HTTP links into text", async () => {
  const html = '<p>See <a href="javascript:alert(1)">this</a> and <a href="data:text/html,x">that</a>.</p>' +
    "<pre>a\n\n\n  \nb</pre>";
  assert.equal((await htmlToMarkdown(html, "https://x.test/")).text, "See this and that.\n\n```\na\n\n\n  \nb\n```");
});

test("htmlToMarkdown survives deeply nested markup", async () => {
  const started = performance.now();
  const { text } = await htmlToMarkdown("<div>".repeat(20_000) + "deep text" + "</div>".repeat(20_000), "https://x.test/");
  assert.ok(performance.now() - started < 10_000);
  assert.match(text, /deep text/);
});

test("htmlToMarkdown splits large lists and wide tables without losing structure", async () => {
  const items = Array.from({ length: 3000 }, (_, i) => `<li>item ${i} ${"x".repeat(30)}</li>`).join("");
  const list = (await htmlToMarkdown(`<ol start="5">${items}</ol>`, "https://x.test/")).text.split("\n").filter(Boolean);
  assert.equal(list.length, 3000);
  assert.match(list[0], /^5\. +item 0 /);
  assert.match(list[2999], /^3004\. +item 2999 /);
  const started = performance.now();
  const wide = await htmlToMarkdown(`<table><tr>${"<td>c</td>".repeat(20_000)}</tr></table>`, "https://x.test/");
  assert.ok(performance.now() - started < 5000);
  assert.equal(wide.text.split("\n").length, 2);
  const broad = "<div>".repeat(13) + "<span>x</span> ".repeat(50_000) + "</div>".repeat(13);
  const broadStarted = performance.now();
  assert.match((await htmlToMarkdown(broad, "https://x.test/")).text, /^x x x/);
  assert.ok(performance.now() - broadStarted < 10_000);
});

test("htmlToMarkdown converts a document without a body element", async () => {
  const { text } = await htmlToMarkdown("<!doctype html><html><p>Hello <b>there</b></p></html>", "https://x.test/");
  assert.equal(text, "Hello **there**");
});

test("htmlToMarkdown keeps nested code, list markers, cell escapes, and image links", async () => {
  const nested = await htmlToMarkdown("<ul><li><p>Step</p><pre>a\n\n\nb</pre></li></ul>", "https://x.test/");
  assert.match(nested.text, /a\n {4}\n {4}\n {4}b/);
  const big = `<code>${"y".repeat(100)}</code> `.repeat(800);
  const list = await htmlToMarkdown(`<h1>T</h1><ol start="3"><li>small</li><li>${big}</li><li>after</li></ol>`, "https://x.test/");
  assert.match(list.text, /\n3\. +small\n\n4\. `y{100}` `y{100}`[^]*`\n\n5\. +after$/);
  const rows = `<tr><td>a\\b|c</td></tr>`.repeat(3000);
  const table = await htmlToMarkdown(`<table><tr><th>h</th></tr>${rows}</table>`, "https://x.test/");
  assert.equal(table.text.split("\n")[2], "| a\\\\b\\|c |");
  const image = await htmlToMarkdown('<p><a href="/x"><img src="i.png" alt="Logo"></a></p>', "https://x.test/");
  assert.equal(image.text, "[Logo](https://x.test/x)");
});

test("htmlToMarkdown leaves scripts and hidden text out of deep pages", async () => {
  const html = "<div>".repeat(300) + "<script>evil()</script><span hidden>secret</span>visible" + "</div>".repeat(300);
  assert.equal((await htmlToMarkdown(html, "https://x.test/")).text, "visible");
});
