// tests/web_test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { fetchWebPage, htmlToMarkdown } from "../web.ts";

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1>Hello World</h1>
  <p>Some <strong>bold</strong> text with a <a href="https://example.com/link">link</a>.</p>
  <ul><li>item one</li><li>item two</li></ul>
  <pre><code>const x = 1 &lt; 2;</code></pre>
  <script>alert('nope')</script>
  <style>.hidden { display: none }</style>
</body>
</html>`;

Deno.test("htmlToMarkdown converts common elements", () => {
  const md = htmlToMarkdown(SAMPLE_HTML);
  assertEquals(md.startsWith("# Test Page"), true);
  assertEquals(md.includes("# Hello World"), true);
  assertEquals(md.includes("**bold**"), true);
  assertEquals(md.includes("[link](https://example.com/link)"), true);
  assertEquals(md.includes("- item one"), true);
  assertEquals(md.includes("const x = 1 < 2;"), true);
  assertEquals(md.includes("alert('nope')"), false);
  assertEquals(md.includes(".hidden"), false);
});

Deno.test("htmlToMarkdown strips raw HTML tags", () => {
  const md = htmlToMarkdown("<p>hello</p><div>world</div>");
  assertEquals(md.includes("<p>"), false);
  assertEquals(md.includes("<div>"), false);
  assertEquals(md.includes("hello"), true);
  assertEquals(md.includes("world"), true);
});

Deno.test("fetchWebPage rejects non-http(s) URLs without network access", async () => {
  await assertRejects(() => fetchWebPage("file:///C:/Windows/win.ini"), Error, "only http/https");
  await assertRejects(() => fetchWebPage("ftp://example.com/file"), Error, "only http/https");
  await assertRejects(() => fetchWebPage("not-a-url"), Error, "Invalid URL:");
});

