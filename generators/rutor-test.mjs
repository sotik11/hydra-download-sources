/**
 * Rutor — Игры (rutor.info, category 8) -> Hydra download source.  [TEST BUILD]
 *
 * Unlike the Igruha sources, everything we need is already in the listing rows,
 * so there is normally NO per-torrent fetch:
 *   - each `<tr class="gai|tum">` row carries title + magnet + size + date;
 *   - one torrent = one release (repacker/type is baked into the title) = one
 *     card, so no variant pairing either.
 *
 * Magnet fallback: if a row's magnet is missing or not a 40-hex btih (e.g. a
 * base32 hash), we fall back to the neighbouring .torrent link
 * (`<a class="downgif" href="//d.rutor.info/download/{id}">`) and rebuild the
 * magnet from the bencode infohash (lib/torrent.mjs) — the same trick Igruha
 * uses. Only broken rows pay for that extra request.
 *
 * Enumeration walks the category listing `/browse/{page}/8/0/0` (newest first,
 * ~100 rows/page, ~286 pages for the full ~28.5k games). A full crawl is just
 * ~286 requests. Incremental runs walk from page 0 and stop once a couple of
 * pages bring nothing new (all torrent ids already known) — torrent pages never
 * change, so a known id is done forever.
 *
 * We keep only PC games: the title must carry a "PC" label in ANY of the four
 * Latin/Cyrillic letter mixes (PC / РС / РC / PС) and must not look like junk
 * (OST / soundtrack / patch / update / artbook / wallpaper / русификатор).
 * Console/mobile rows lack a PC label and drop out on their own.
 *
 * The page is UTF-8 (the <meta> says so and it decodes clean), so plain getText.
 *
 * Env:
 *   PAGES=N   walk only the first N listing pages (slice test)
 *   FULL=1    ignore existing state, rebuild the whole category from page 0
 *   POOL=N    concurrent workers for page fetch + magnet fallback (default 6)
 *   RATE=N    global request cap (req/sec); 0 = unthrottled
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getText, getBuffer, mapPool, sleep } from "../lib/net.mjs";
import { torrentToMagnet } from "../lib/torrent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://rutor.info";
const CAT = 8; // "Игры"
const NAME = "Rutor Test";
const OUT = process.env.OUT || join(ROOT, "data", "rutor-test.json");
const STATE = process.env.STATE || join(ROOT, "data", "rutor-test.state.json");

const PAGES = Number(process.env.PAGES) || 0; // slice: first N pages
const FULL = process.env.FULL === "1";
const POOL = Number(process.env.POOL) || 6;
const RATE = Number(process.env.RATE) || 0;
const MAX_PAGE = 400; // safety cap for the incremental/full walk
const STOP_STREAK = 2; // stop after this many consecutive all-known pages

const gapMs = RATE > 0 ? 1000 / RATE : 0;
let nextSlot = 0;
async function throttle() {
  if (!gapMs) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gapMs;
  if (wait) await sleep(wait);
}

// --- title parsing / filtering ---------------------------------------------

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

// "PC" label in any Latin/Cyrillic mix: P|Р followed by C|С, as a standalone
// token. \p{L} boundaries keep it from matching inside a word.
const PC_RE = /(?:^|[^\p{L}])[PР][CС](?:[^\p{L}]|$)/u;

// OST is a case-sensitive acronym so we don't nuke Ghost/Frost/Lost/Outpost.
const OST_RE = /(?:^|[^A-Za-z])OST(?:[^A-Za-z]|$)/;
// standalone "update" (keeps "Updated Edition"); the rest are safe substrings.
const UPDATE_RE = /(?:^|[^a-z])update(?:[^a-z]|$)/i;
const JUNK_RE =
  /soundtrack|саундтрек|русификатор|патч|артбук|artbook|руководство|обои|wallpaper/i;

const isPcGame = (title) =>
  PC_RE.test(title) && !OST_RE.test(title) && !UPDATE_RE.test(title) && !JUNK_RE.test(title);

const MONTHS = {
  Янв: 0, Фев: 1, Мар: 2, Апр: 3, Май: 4, Июн: 5,
  Июл: 6, Авг: 7, Сен: 8, Окт: 9, Ноя: 10, Дек: 11,
};

/** "26 Июл 26" -> ISO date; unknown -> epoch (date barely matters to Hydra). */
function parseDate(cell) {
  const t = (cell || "").replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, " ").trim();
  const m = t.match(/(\d{1,2})\s+([А-Яа-я]{3})\s+(\d{2})/);
  const mon = m ? MONTHS[m[2]] : undefined;
  if (mon === undefined) return new Date(0).toISOString();
  const d = new Date(Date.UTC(2000 + Number(m[3]), mon, Number(m[1])));
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

const VALID_MAGNET = /^magnet:\?xt=urn:btih:[0-9a-fA-F]{40}/;

/** Parse one listing page into { total, kept:[{id,title,magnet,dl,size,date}] }. */
function parseRows(html) {
  const rows = html.match(/<tr class="(?:gai|tum)">[\s\S]*?<\/tr>/g) || [];
  const kept = [];
  for (const row of rows) {
    const idM = row.match(/\/torrent\/(\d+)\//);
    const titM = row.match(/\/torrent\/\d+\/[^"]*">([\s\S]*?)<\/a>/);
    if (!idM || !titM) continue;

    const title = clean(titM[1]);
    if (!title || !isPcGame(title)) continue;

    const magM = row.match(/href="(magnet:\?xt=urn:btih:[0-9a-fA-F]{40}[^"]*)"/i);
    const magnet = magM ? magM[1].replace(/&amp;/g, "&") : null;

    // Neighbouring .torrent link, the fallback source for a broken magnet.
    const dlM = row.match(/<a class="downgif"[^>]*href="([^"]+)"/i);
    let dl = dlM ? dlM[1] : null;
    if (dl && dl.startsWith("//")) dl = `https:${dl}`;
    if (!magnet && !dl) continue; // nothing to build a magnet from

    const sizeM = row.match(
      /<td align="right">\s*([\d.,]+)&nbsp;(GB|MB|KB|TB)\s*<\/td>/i
    );
    const size = sizeM ? `${sizeM[1]} ${sizeM[2].toUpperCase()}` : "";
    const date = parseDate((row.match(/<td>([^<]+)<\/td>/) || [])[1]);
    kept.push({ id: idM[1], title, magnet, dl, size, date });
  }
  return { total: rows.length, kept };
}

/**
 * Resolve a row to a Hydra download object. Uses the listing magnet when it is a
 * valid 40-hex btih; otherwise falls back to the .torrent link. Returns null if
 * neither yields a magnet.
 */
async function resolveDownload(row) {
  let magnet = row.magnet && VALID_MAGNET.test(row.magnet) ? row.magnet : null;
  if (!magnet && row.dl) {
    try {
      await throttle();
      const buf = await getBuffer(row.dl, { ms: 20000, tries: 2 });
      const built = torrentToMagnet(buf).magnet;
      if (VALID_MAGNET.test(built)) magnet = built;
    } catch {
      // dead .torrent — leave unresolved, retried next run
    }
  }
  if (!magnet) return null;
  return { title: row.title, uris: [magnet], uploadDate: row.date, fileSize: row.size };
}

async function fetchPage(page) {
  await throttle();
  const html = await getText(`${SITE}/browse/${page}/${CAT}/0/0`, {
    ms: 30000,
    tries: 3,
  });
  return parseRows(html);
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
  const prev = await readState();
  const next = FULL ? {} : { ...prev };
  const limit = PAGES || MAX_PAGE;

  // New rows discovered this run (id not already known) -> resolved after the
  // walk so the magnet-fallback fetches run through the pool, not inline.
  const fresh = [];
  const queued = new Set();
  let reused = 0;
  let filtered = 0;
  let walked = 0;
  let knownStreak = 0;

  for (let page = 0; page < limit; page += 1) {
    let res;
    try {
      res = await fetchPage(page);
    } catch (e) {
      console.warn(`[rutor] page ${page} failed: ${e.message}`);
      if (PAGES) continue; // slice: skip the bad page
      break; // walk: treat as the end, keep what we have
    }
    walked += 1;
    if (res.total === 0) break; // walked past the last page

    let pageNew = 0;
    for (const row of res.kept) {
      if ((!FULL && next[row.id] !== undefined) || queued.has(row.id)) {
        reused += 1;
        continue;
      }
      queued.add(row.id);
      fresh.push(row);
      pageNew += 1;
    }
    filtered += res.total - res.kept.length;

    if (page % 25 === 0 || pageNew) {
      console.log(
        `[rutor] page ${page}: +${pageNew} pc (${res.kept.length}/${res.total} kept)`
      );
    }

    // Incremental full walk (no PAGES/FULL): stop once pages go all-known.
    if (!FULL && !PAGES) {
      if (pageNew === 0) {
        knownStreak += 1;
        if (knownStreak >= STOP_STREAK) {
          console.log(`[rutor] ${STOP_STREAK} all-known pages -> stop at ${page}`);
          break;
        }
      } else {
        knownStreak = 0;
      }
    }
  }

  // Resolve magnets (with .torrent fallback) for the fresh rows.
  let added = 0;
  let fellBack = 0;
  let dropped = 0;
  const resolved = await mapPool(fresh, POOL, async (row) => {
    const dl = await resolveDownload(row);
    if (dl) {
      if (!row.magnet || !VALID_MAGNET.test(row.magnet)) fellBack += 1;
      return { id: row.id, dl };
    }
    dropped += 1;
    return null;
  });
  for (const r of resolved) {
    if (!r) continue;
    next[r.id] = r.dl;
    added += 1;
  }

  const downloads = Object.keys(next)
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => next[id]);

  await writeFile(OUT, `${JSON.stringify({ name: NAME, downloads }, null, 2)}\n`, "utf8");
  await writeFile(STATE, `${JSON.stringify(next)}\n`, "utf8");

  console.log(
    `[rutor] done -> ${downloads.length} downloads ` +
      `(walked ${walked} pages, +${added} new, reused ${reused}, ` +
      `filtered ${filtered} non-pc/junk, fallback ${fellBack}, dropped ${dropped})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
