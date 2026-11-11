#!/usr/bin/env node
"use strict";

// Fast web search without the browser: DuckDuckGo's HTML endpoint.
// Usage: websearch "<query>" [--n 8] [--region uz-uz]

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Safari/537.36";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[t.slice(2)] = true;
      else {
        out[t.slice(2)] = next;
        i++;
      }
    } else out._.push(t);
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function realUrl(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : u.href;
  } catch {
    return href;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args._.join(" ").trim() || args.q || args.query;
  if (!query) {
    console.error('Usage: websearch "<query>" [--n 8] [--region uz-uz]');
    process.exit(1);
  }
  const n = Math.max(1, Math.min(15, Number(args.n || 8)));
  const params = new URLSearchParams({ q: String(query) });
  if (args.region) params.set("kl", String(args.region));

  const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    headers: { "User-Agent": UA, "Accept-Language": "uz,ru;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  const html = await res.text();

  const results = [];
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const b of blocks) {
    if (/result--ad/.test(b.slice(0, 200))) continue;
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({
      title: decodeEntities(a[2]),
      url: realUrl(a[1].replace(/&amp;/g, "&")),
      snippet: snip ? decodeEntities(snip[1]) : "",
    });
    if (results.length >= n) break;
  }

  if (!results.length) {
    console.log(`no results for "${query}" (search may be rate-limited; fall back to the browser)`);
    return;
  }
  console.log(`results for "${query}":`);
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
  });
}

main().catch((e) => {
  console.error(`websearch error: ${e.message}`);
  process.exit(1);
});
