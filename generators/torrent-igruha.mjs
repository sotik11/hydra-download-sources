/**
 * Torrent Игруха (itorrents-igruha.org) -> Hydra download source.
 *
 * Output: data/torrent-igruha.json in Hydra's download-source shape
 *   { name, downloads: [{ title, uris, uploadDate, fileSize }] }
 *
 * Per game (2 requests):
 *   1. /{id}-slug.html   -> title (h1), fileSize ("Размер:"), uploadDate
 *                           (<time datetime>), and the download id in
 *                           `?do=download&id=N`.
 *   2. /engine/download.php?id=N -> the .torrent, which we turn into a magnet
 *      (Hydra only enables the Torrent downloader for magnet: URIs).
 *
 * The site is windows-1251 and NOT behind a Cloudflare JS challenge, so plain
 * fetch works; pages/torrents are read as raw bytes and decoded explicitly.
 *
 * Env:
 *   LIMIT=N     process only the first N game pages (slice test)
 *   POOL=N      concurrent workers (default 5)
 */
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuffer, getText, mapPool, sleep } from "../lib/net.mjs";
import { torrentToMagnet } from "../lib/torrent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://itorrents-igruha.org";
const NAME = "Торрент Игруха";
const OUT = join(ROOT, "data", "torrent-igruha.json");

const LIMIT = Number(process.env.LIMIT) || 0;
const SAMPLE = Number(process.env.SAMPLE) || 0; // spread-sample N across the sitemap
const POOL = Number(process.env.POOL) || 5;
// Global request rate cap (requests/sec). 0 = unthrottled. Spacing every
// request by 1000/RATE ms keeps the real throughput at RATE regardless of POOL,
// so the site's WAF stays calm on the ~46k-request full run.
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

const cp1251 = new TextDecoder("windows-1251");

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

/** All game-page URLs from the sitemap: /{id}-slug.html, excluding -download pages. */
async function listGamePages() {
  const xml = await getText(`${SITE}/sitemap.xml`, { ms: 30000 });
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return locs.filter(
    (u) => /\/\d+-[^/]+\.html$/.test(u) && !/-download\.html$/.test(u)
  );
}

// Skip reasons. "no-torrent"/"no-title" are genuine (the page loaded but has no
// distribution); the rest are transient network failures worth a retry.
const TRANSIENT = new Set(["fetch-page", "fetch-torrent", "parse-torrent"]);

/** @returns {{download}|{skip:string}} */
async function buildDownload(pageUrl) {
  let bytes;
  try {
    await throttle();
    bytes = await getBuffer(pageUrl, { ms: 15000 });
  } catch {
    return { skip: "fetch-page" };
  }

  const html = cp1251.decode(bytes);
  const idMatch = html.match(/[?&]do=download&(?:amp;)?id=(\d+)/);
  if (!idMatch) return { skip: "no-torrent" }; // "Нет раздачи"
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
      `${SITE}/engine/download.php?id=${downloadId}`,
      { ms: 20000 }
    );
    magnet = torrentToMagnet(torrent).magnet;
  } catch {
    return { skip: "fetch-torrent" };
  }
  if (!/^magnet:\?xt=urn:btih:[0-9a-f]{40}/.test(magnet))
    return { skip: "parse-torrent" };

  return { download: { title, uris: [magnet], uploadDate, fileSize } };
}

/** Evenly spread N URLs across the whole list (fair diagnostic sample). */
function spreadSample(urls, n) {
  if (n >= urls.length) return urls;
  const step = urls.length / n;
  return Array.from({ length: n }, (_, i) => urls[Math.floor(i * step)]);
}

async function runPass(urls, label) {
  let done = 0;
  const results = await mapPool(urls, POOL, async (url) => {
    const r = await buildDownload(url);
    done += 1;
    if (done % 250 === 0) console.log(`[igruha] ${label} ${done}/${urls.length}`);
    return { url, ...r };
  });
  return results;
}

async function main() {
  let pages = await listGamePages();
  console.log(`[igruha] sitemap: ${pages.length} game pages`);
  if (SAMPLE) {
    pages = spreadSample(pages, SAMPLE);
    console.log(`[igruha] SAMPLE=${SAMPLE} -> spread across the sitemap`);
  } else if (LIMIT) {
    pages = pages.slice(0, LIMIT);
    console.log(`[igruha] LIMIT=${LIMIT} -> processing ${pages.length}`);
  }

  let results = await runPass(pages, "pass1");

  // Retry pass over transient failures only — recovers games dropped to a
  // one-off timeout rather than a genuine missing distribution.
  const retryUrls = results.filter((r) => TRANSIENT.has(r.skip)).map((r) => r.url);
  if (retryUrls.length) {
    console.log(`[igruha] retry: ${retryUrls.length} transient failures`);
    const retried = await runPass(retryUrls, "retry");
    const byUrl = new Map(retried.map((r) => [r.url, r]));
    results = results.map((r) => (byUrl.has(r.url) ? byUrl.get(r.url) : r));
  }

  const downloads = results.filter((r) => r.download).map((r) => r.download);

  // Skip breakdown.
  const reasons = {};
  for (const r of results) if (r.skip) reasons[r.skip] = (reasons[r.skip] || 0) + 1;

  await writeFile(
    OUT,
    `${JSON.stringify({ name: NAME, downloads }, null, 2)}\n`,
    "utf8"
  );

  const brk = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(
    `[igruha] done -> ${downloads.length} downloads, skipped ${
      pages.length - downloads.length
    } (${brk || "none"})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
