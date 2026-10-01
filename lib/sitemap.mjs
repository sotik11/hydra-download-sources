// Sitemap walker that copes with both shapes a site can serve:
//   - a flat <urlset> with <url> entries, or
//   - a <sitemapindex> whose <sitemap> children are themselves sitemaps.
//
// Both Igruha sites switched from the former to the latter (and split their
// game list across several child files once it passed 10 000 urls), which a
// "parse <url> in sitemap.xml" / "take the first child" reader silently turned
// into an empty or truncated game list. Walking every child means the next
// split (games-4, news_pages3, …) is picked up without a code change.

import { getText } from "./net.mjs";

const blocks = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const field = (block, tag) =>
  (block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`)) || [])[1]?.trim() || "";

/**
 * Every { url, lastmod } reachable from `rootUrl`, de-duplicated by url (the
 * newest lastmod wins — a page can sit in both a "fresh" and a "full" child).
 * Throws if a child sitemap cannot be fetched: a partial list must never pass
 * for the real one.
 * @param {string} rootUrl
 * @param {{ childFilter?: (loc: string) => boolean, ms?: number }} [opts]
 */
export async function collectSitemapUrls(rootUrl, { childFilter = () => true, ms = 60000 } = {}) {
  const root = await getText(rootUrl, { ms });
  const children = blocks(root, "sitemap")
    .map((b) => field(b, "loc"))
    .filter(Boolean)
    .filter(childFilter);

  const docs = children.length ? [] : [root];
  for (const loc of children) docs.push(await getText(loc, { ms }));

  const byUrl = new Map();
  for (const xml of docs) {
    for (const b of blocks(xml, "url")) {
      const url = field(b, "loc");
      if (!url) continue;
      const lastmod = field(b, "lastmod");
      const seen = byUrl.get(url);
      if (seen === undefined || lastmod > seen) byUrl.set(url, lastmod);
    }
  }
  return [...byUrl].map(([url, lastmod]) => ({ url, lastmod }));
}

/**
 * Refuse a game list that is empty or has collapsed against what we already
 * know. Thrown BEFORE any state is written, so a broken sitemap can neither
 * wipe the incremental state nor shrink the feed.
 * @param {string} tag      log prefix
 * @param {number} found    game pages in the sitemap now
 * @param {number} known    game pages in the previous state (0 = no baseline)
 * @param {number} [minRatio]
 */
export function assertSaneCount(tag, found, known, minRatio = 0.7) {
  if (!found) throw new Error(`[${tag}] sitemap yielded 0 game pages — layout changed or blocked`);
  if (known && found < known * minRatio) {
    throw new Error(
      `[${tag}] sitemap yielded ${found} game pages vs ${known} known ` +
        `(<${Math.round(minRatio * 100)}%) — refusing to shrink state`
    );
  }
}
