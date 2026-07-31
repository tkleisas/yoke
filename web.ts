// web.ts
// Web access for the agent: fetch a page as markdown-ish text, or search
// the web (DuckDuckGo HTML endpoint — no API key required).

const MAX_WEB_CONTENT_CHARS = 20_000;
const WEB_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESULTS = 6;
const USER_AGENT = "Mozilla/5.0 (compatible; YokeAgent/1.0)";

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol '${url.protocol}' — only http/https are allowed.`);
  }
  return url;
}

async function httpGet(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.text();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Timed out after ${WEB_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new Error(`Failed to fetch: ${errString(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanText(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : "";

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (_, level, inner) =>
      `\n\n${"#".repeat(Number(level))} ${cleanText(inner)}\n\n`)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = cleanText(inner);
      return label ? `[${label}](${href})` : href;
    })
    .replace(/<li(?:\s[^>]*)?>/gi, "\n- ")
    .replace(/<(?:br|p|div|tr|table|ul|ol|section|article)(?:\s[^>]*)?>/gi, "\n\n")
    .replace(/<(?:pre|code)(?:\s[^>]*)?>/gi, "\n```\n")
    .replace(/<\/(?:pre|code)>/gi, "\n```\n")
    .replace(/<(?:strong|b)(?:\s[^>]*)?>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)(?:\s[^>]*)?>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (title && !text.startsWith(title)) {
    text = `# ${title}\n\n${text}`;
  }
  return text;
}

export async function fetchWebPage(rawUrl: string): Promise<string> {
  const url = validateUrl(rawUrl);
  const html = await httpGet(url.href);
  let text = htmlToMarkdown(html);
  if (text.length > MAX_WEB_CONTENT_CHARS) {
    text = text.slice(0, MAX_WEB_CONTENT_CHARS) + "\n...[truncated]";
  }
  return `Source: ${url.href}\n\n${text}`;
}

function xmlField(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`));
  if (!match) return "";
  return decodeEntities(match[1]).trim();
}

export async function searchWeb(query: string, maxResults = MAX_SEARCH_RESULTS): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error("Search query must not be empty.");
  // Bing's RSS format serves real results without JavaScript rendering.
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`;
  const body = await httpGet(url);

  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const match of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (results.length >= maxResults) break;
    const item = match[1];
    const title = xmlField(item, "title");
    const link = xmlField(item, "link");
    const snippet = xmlField(item, "description").slice(0, 250);
    if (title || link) results.push({ title, url: link, snippet });
  }

  if (results.length === 0) {
    return `No web results for '${q}'.`;
  }

  const lines = [`Web results for '${q}':`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || "(untitled)"}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join("\n");
}
