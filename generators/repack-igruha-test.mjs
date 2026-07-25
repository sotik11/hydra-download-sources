/**
 * Repack Игруха (repack-igruha.net) -> Hydra download source.  [TEST BUILD]
 *
 * Test naming on purpose (repack-igruha-test.json / "Repack Igruha Test") so the
 * throwaway test URL and its stale content never collide with the final feed in
 * Hydra's URL-keyed backend cache. Renamed to repack-igruha on finalization.
 *
 * Sibling of itorrents-igruha.mjs, same operator (byigruha). Differences:
 *   - UTF-8 pages (plain getText), not windows-1251.
 *   - Enumeration is a two-step sitemap: sitemap.xml is an index -> the games
 *     live in the news_pages.xml sub-sitemap (100% full-ISO <lastmod>).
 *   - The torrent link `index.php?do=download&id=N` serves the .torrent directly
 *     but requires a Referer header (the game page) or it 302s "Access denied".
 *   - HTML entities in the <h1> title (&#039; etc.) are decoded.
 *
 * Per game (2 requests): page -> title/size/date/download-id, then the torrent.
 *
 * Env: LIMIT / SAMPLE / POOL / RATE / FULL — as in itorrents-igruha.mjs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuffer, getText, mapPool, sleep } from "../lib/net.mjs";
import { torrentToMagnet } from "../lib/torrent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://repack-igruha.net";
const NAME = "Repack Igruha Test";
const OUT = process.env.OUT || join(ROOT, "data", "repack-igruha-test.json");
const STATE =
  process.env.STATE || join(ROOT, "data", "repack-igruha-test.state.json");

const LIMIT = Number(process.env.LIMIT) || 0;
const SAMPLE = Number(process.env.SAMPLE) || 0;
const POOL = Number(process.env.POOL) || 5;
const FULL = process.env.FULL === "1";
const RATE = Number(process.env.RATE) || 0;

const gapMs = RATE > 0 ? 1000 / RATE : 0;
let nextSlot = 0;
async function throttle() {
  if (!gapMs) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gapMs;
  if (wait) await sleep(wait);
}

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const clean = (s) =>
  decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Game pages: sitemap.xml is an index; games live in the news sub-sitemap. */
async function listGamePages() {
  const index = await getText(`${SITE}/sitemap.xml`, { ms: 30000 });
  const newsLoc = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .find((u) => /news[_-]?pages/i.test(u));
  const xml = newsLoc ? await getText(newsLoc, { ms: 30000 }) : index;

  const out = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const b = block[1];
    const url = (b.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!url || !/\/\d+-[^/]+\.html$/.test(url)) continue;
    const lastmod = (b.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || "";
    out.push({ url, lastmod });
  }
  return out;
}

const TRANSIENT = new Set(["fetch-page", "fetch-torrent", "parse-torrent"]);

/** @returns {{download}|{skip:string}} */
async function buildDownload(pageUrl) {
  let html;
  try {
    await throttle();
    html = await getText(pageUrl, { ms: 15000 });
  } catch {
    return { skip: "fetch-page" };
  }

  const idMatch = html.match(/[?&]do=download&(?:amp;)?id=(\d+)/);
  if (!idMatch) return { skip: "no-torrent" };
  const downloadId = idMatch[1];

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? clean(h1[1]) : null;
  if (!title) return { skip: "no-title" };

  const sizeMatch = html.match(/Размер\s*:?\s*([\d.,]+\s*(?:[GMKT]B|[ГМКТ]б))/i);
  const fileSize = sizeMatch ? sizeMatch[1].replace(/\s+/g, " ").trim() : "";

  const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"/i);
  let uploadDate = new Date(0).toISOString();
  if (timeMatch) {
    const d = new Date(timeMatch[1]);
    if (!Number.isNaN(d.getTime())) uploadDate = d.toISOString();
  }

  let magnet;
  try {
    await throttle();
    const torrent = await getBuffer(
      `${SITE}/index.php?do=download&id=${downloadId}`,
      { headers: { Referer: pageUrl }, ms: 20000 }
    );
    magnet = torrentToMagnet(torrent).magnet;
  } catch {
    return { skip: "fetch-torrent" };
  }
  if (!/^magnet:\?xt=urn:btih:[0-9a-f]{40}/.test(magnet))
    return { skip: "parse-torrent" };

  return { download: { title, uris: [magnet], uploadDate, fileSize } };
}

function spreadSample(items, n) {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

async function runPass(items, label) {
  let done = 0;
  return mapPool(items, POOL, async (item) => {
    const r = await buildDownload(item.url);
    done += 1;
    if (done % 250 === 0) console.log(`[repack] ${label} ${done}/${items.length}`);
    return { ...item, ...r };
  });
}

async function readState() {
  if (FULL) return {};
  try {
    return JSON.parse(await readFile(STATE, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  let pages = await listGamePages();
  console.log(`[repack] sitemap: ${pages.length} game pages`);
  if (SAMPLE) {
    pages = spreadSample(pages, SAMPLE);
    console.log(`[repack] SAMPLE=${SAMPLE} -> spread across the sitemap`);
  } else if (LIMIT) {
    pages = pages.slice(0, LIMIT);
    console.log(`[repack] LIMIT=${LIMIT} -> processing ${pages.length}`);
  }

  const prev = await readState();
  const toFetch = [];
  const nextState = {};
  let reused = 0;

  for (const page of pages) {
    const cached = prev[page.url];
    if (cached && cached.lastmod === page.lastmod) {
      nextState[page.url] = cached;
      reused += 1;
    } else {
      toFetch.push(page);
    }
  }

  const added = toFetch.filter((p) => !prev[p.url]).length;
  const updated = toFetch.length - added;
  const removed = Object.keys(prev).filter(
    (u) => !nextState[u] && !toFetch.some((p) => p.url === u)
  ).length;
  console.log(
    `[repack] reuse ${reused}, fetch ${toFetch.length} (new ${added}, changed ${updated}), drop ${removed}`
  );

  let fetched = await runPass(toFetch, "fetch");
  const retry = fetched.filter((r) => TRANSIENT.has(r.skip));
  if (retry.length) {
    console.log(`[repack] retry: ${retry.length} transient failures`);
    const again = await runPass(retry, "retry");
    const byUrl = new Map(again.map((r) => [r.url, r]));
    fetched = fetched.map((r) => byUrl.get(r.url) ?? r);
  }

  const reasons = {};
  for (const r of fetched) {
    nextState[r.url] = { lastmod: r.lastmod, download: r.download ?? null };
    if (r.skip) reasons[r.skip] = (reasons[r.skip] || 0) + 1;
  }

  const downloads = Object.keys(nextState)
    .sort()
    .map((u) => nextState[u].download)
    .filter(Boolean);

  await writeFile(OUT, `${JSON.stringify({ name: NAME, downloads }, null, 2)}\n`, "utf8");
  if (!SAMPLE) {
    await writeFile(STATE, `${JSON.stringify(nextState)}\n`, "utf8");
  }

  const brk = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(
    `[repack] done -> ${downloads.length} downloads (fetched ${toFetch.length}: ${brk || "all ok"})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
