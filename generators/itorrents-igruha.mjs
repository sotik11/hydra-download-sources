/**
 * Torrent Игруха (itorrents-igruha.org) -> Hydra download source.
 *
 * Output: data/itorrents-igruha.json in Hydra's download-source shape
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
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuffer, getText, mapPool, sleep } from "../lib/net.mjs";
import { torrentToMagnet } from "../lib/torrent.mjs";
import { parseVariants, toDownloads } from "../lib/variants.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://itorrents-igruha.org";
const NAME = "Torrent Igruha";
const OUT = process.env.OUT || join(ROOT, "data", "itorrents-igruha.json");
const STATE = process.env.STATE || join(ROOT, "data", "itorrents-igruha.state.json");

const LIMIT = Number(process.env.LIMIT) || 0;
const SAMPLE = Number(process.env.SAMPLE) || 0; // spread-sample N across the sitemap
const POOL = Number(process.env.POOL) || 5;
const FULL = process.env.FULL === "1"; // ignore existing state, rebuild from scratch
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

/** Game pages from the sitemap: [{ url, lastmod }] for /{id}-slug.html. */
async function listGamePages() {
  const xml = await getText(`${SITE}/sitemap.xml`, { ms: 30000 });
  const out = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const b = block[1];
    const url = (b.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!url || !/\/\d+-[^/]+\.html$/.test(url) || /-download\.html$/.test(url))
      continue;
    const lastmod = (b.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || "";
    out.push({ url, lastmod });
  }
  return out;
}

// Retried within a run and re-fetched next run. Genuine outcomes
// (no-torrent / no-title / page-gone) are cached instead.
const TRANSIENT = new Set(["fetch-page", "fetch-torrent"]);

/** @returns {{downloads: object[]}|{skip: string}} */
async function buildDownload(pageUrl) {
  let bytes;
  try {
    await throttle();
    bytes = await getBuffer(pageUrl, { ms: 15000, tries: 2 });
  } catch (e) {
    // 4xx = the page is gone (stale sitemap entry) -> genuine skip, cache it;
    // anything else is a transient network error worth a retry.
    return { skip: /->\s*4\d\d/.test(e.message) ? "page-gone" : "fetch-page" };
  }

  const html = cp1251.decode(bytes);
  const variants = parseVariants(html);
  if (!variants.length) return { skip: "no-torrent" }; // "Нет раздачи"

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const baseTitle = h1 ? clean(h1[1]) : null;
  if (!baseTitle) return { skip: "no-title" };

  const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"/i);
  let uploadDate = new Date(0).toISOString();
  if (timeMatch) {
    const d = new Date(timeMatch[1]);
    if (!Number.isNaN(d.getTime())) uploadDate = d.toISOString();
  }

  const working = [];
  let networkError = false;
  for (const v of variants) {
    let torrent;
    try {
      await throttle();
      torrent = await getBuffer(`${SITE}/engine/download.php?id=${v.id}`, {
        ms: 20000,
        tries: 1,
      });
    } catch (e) {
      // "GET … -> 403/404" = this variant is gone, try the next; anything else
      // (timeout / reset) is a transient network error.
      if (!/->\s*\d/.test(e.message)) networkError = true;
      continue;
    }
    let magnet;
    try {
      magnet = torrentToMagnet(torrent).magnet;
    } catch {
      continue; // not a valid torrent — dead/blocked variant
    }
    if (/^magnet:\?xt=urn:btih:[0-9a-f]{40}/.test(magnet)) {
      working.push({ ...v, magnet });
    }
  }

  if (!working.length) return { skip: networkError ? "fetch-torrent" : "no-torrent" };
  return { downloads: toDownloads(baseTitle, uploadDate, working) };
}

/** Evenly spread N items across the whole list (fair diagnostic sample). */
function spreadSample(items, n) {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/** Fetch a batch of {url,lastmod}; returns them enriched with download|skip. */
async function runPass(items, label) {
  let done = 0;
  return mapPool(items, POOL, async (item) => {
    const r = await buildDownload(item.url);
    done += 1;
    if (done % 250 === 0) console.log(`[igruha] ${label} ${done}/${items.length}`);
    return { ...item, ...r };
  });
}

async function readState() {
  if (FULL) return {};
  try {
    const raw = JSON.parse(await readFile(STATE, "utf8"));
    // Migrate the old single-download schema { lastmod, download } to the
    // multi-variant one { lastmod, downloads: [] }.
    for (const e of Object.values(raw)) {
      if (e.downloads === undefined) {
        e.downloads = e.download ? [e.download] : [];
        delete e.download;
      }
    }
    return raw;
  } catch {
    return {}; // no state yet -> first run rebuilds everything
  }
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

  // Incremental: reuse cached entries whose sitemap lastmod is unchanged; only
  // (re)fetch new or modified pages. State keeps no-torrent pages too (as
  // download:null) so they aren't re-fetched every run until they change.
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
    `[igruha] reuse ${reused}, fetch ${toFetch.length} (new ${added}, changed ${updated}), drop ${removed}`
  );

  let fetched = await runPass(toFetch, "fetch");
  const retry = fetched.filter((r) => TRANSIENT.has(r.skip));
  if (retry.length) {
    console.log(`[igruha] retry: ${retry.length} transient failures`);
    const again = await runPass(retry, "retry");
    const byUrl = new Map(again.map((r) => [r.url, r]));
    fetched = fetched.map((r) => byUrl.get(r.url) ?? r);
  }

  const reasons = {};
  for (const r of fetched) {
    // Persist successes and GENUINE absences (no-torrent / no-title / page-gone)
    // so we don't re-fetch them until their sitemap lastmod changes. Transient
    // failures are NOT persisted -> they land in toFetch again next run instead
    // of getting stuck.
    if (r.downloads) {
      nextState[r.url] = { lastmod: r.lastmod, downloads: r.downloads };
    } else if (!TRANSIENT.has(r.skip)) {
      nextState[r.url] = { lastmod: r.lastmod, downloads: [] };
    }
    if (r.skip) reasons[r.skip] = (reasons[r.skip] || 0) + 1;
  }

  // Stable order (by url) so the committed feed has minimal git churn.
  const downloads = Object.keys(nextState)
    .sort()
    .flatMap((u) => nextState[u].downloads || []);

  await writeFile(OUT, `${JSON.stringify({ name: NAME, downloads }, null, 2)}\n`, "utf8");
  if (!SAMPLE) {
    await writeFile(STATE, `${JSON.stringify(nextState)}\n`, "utf8");
  }

  const brk = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(
    `[igruha] done -> ${downloads.length} downloads (fetched ${toFetch.length}: ${brk || "all ok"})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
