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
import { getBuffer, getText, mapPool } from "../lib/net.mjs";
import { torrentToMagnet } from "../lib/torrent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://itorrents-igruha.org";
const NAME = "Торрент Игруха";
const OUT = join(ROOT, "data", "torrent-igruha.json");

const LIMIT = Number(process.env.LIMIT) || 0;
const POOL = Number(process.env.POOL) || 5;

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

/** Parse a game page into a partial download entry, or null if it is not a game. */
function parseGamePage(bytes) {
  const html = cp1251.decode(bytes);

  const idMatch = html.match(/[?&]do=download&(?:amp;)?id=(\d+)/);
  if (!idMatch) return null; // online services / non-torrent pages
  const downloadId = idMatch[1];

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? clean(h1[1]) : null;
  if (!title) return null;

  const sizeMatch = html.match(
    /Размер\s*:?\s*([\d.,]+\s*(?:[GMKT]B|[ГМКТ]б))/i
  );
  const fileSize = sizeMatch ? sizeMatch[1].replace(/\s+/g, " ").trim() : null;

  const timeMatch = html.match(
    /<time[^>]*datetime="([^"]+)"/i
  );
  let uploadDate = null;
  if (timeMatch) {
    const d = new Date(timeMatch[1]);
    if (!Number.isNaN(d.getTime())) uploadDate = d.toISOString();
  }

  return { title, downloadId, fileSize, uploadDate };
}

async function buildDownload(pageUrl) {
  let bytes;
  try {
    bytes = await getBuffer(pageUrl, { ms: 15000 });
  } catch {
    return null;
  }
  const parsed = parseGamePage(bytes);
  if (!parsed) return null;

  let magnet;
  try {
    const torrent = await getBuffer(
      `${SITE}/engine/download.php?id=${parsed.downloadId}`,
      { ms: 20000 }
    );
    magnet = torrentToMagnet(torrent).magnet;
  } catch {
    return null; // no reachable torrent -> unusable entry, drop it
  }

  return {
    title: parsed.title,
    uris: [magnet],
    uploadDate: parsed.uploadDate ?? new Date(0).toISOString(),
    fileSize: parsed.fileSize ?? "",
  };
}

async function main() {
  let pages = await listGamePages();
  console.log(`[igruha] sitemap: ${pages.length} game pages`);
  if (LIMIT) {
    pages = pages.slice(0, LIMIT);
    console.log(`[igruha] LIMIT=${LIMIT} -> processing ${pages.length}`);
  }

  let done = 0;
  const results = await mapPool(pages, POOL, async (url) => {
    const d = await buildDownload(url);
    done += 1;
    if (done % 250 === 0) console.log(`[igruha]   ${done}/${pages.length}`);
    return d;
  });

  const downloads = results.filter(Boolean);
  const skipped = results.length - downloads.length;

  await writeFile(
    OUT,
    `${JSON.stringify({ name: NAME, downloads }, null, 2)}\n`,
    "utf8"
  );

  console.log(
    `[igruha] done -> ${downloads.length} downloads (skipped ${skipped}), written to data/torrent-igruha.json`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
