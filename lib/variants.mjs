// Parse the download variants on an Igruha game page.
//
// A page can list several download blocks (main repack / portable / P2P / …),
// each rendered as a "Размер: <size> [version] | <type>" line immediately
// followed by its "СКАЧАТЬ ТОРРЕНТ" button (a ?do=download&id=N link). We pair
// each download id with the nearest preceding size line to recover, per
// variant, its id + human size + type label.

const SIZE_RE = /Размер\s*:?\s*([^<\n]{0,120})/gi;
const DL_RE = /[?&]do=download&(?:amp;)?id=(\d+)/g;
const UNIT_RE = /([\d.,]+\s*(?:GB|MB|KB|TB|ГБ|МБ|КБ))/i;
const MAX_GAP = 2000; // bytes between the size line and its download button

/** @returns {{ id: string, size: string, label: string }[]} in page order */
export function parseVariants(html) {
  const sizes = [...html.matchAll(SIZE_RE)].map((m) => ({
    pos: m.index,
    text: m[1],
  }));
  const dls = [...html.matchAll(DL_RE)].map((m) => ({ pos: m.index, id: m[1] }));

  const out = [];
  const seen = new Set();
  for (const dl of dls) {
    if (seen.has(dl.id)) continue;
    seen.add(dl.id);

    // nearest size line before this download button, within MAX_GAP
    let best = null;
    for (const s of sizes) {
      if (s.pos >= dl.pos) break;
      if (dl.pos - s.pos < MAX_GAP) best = s;
    }

    let size = "";
    let label = "";
    if (best) {
      size = (best.text.match(UNIT_RE)?.[1] || "").replace(/\s+/g, " ").trim();
      // type after the "|": "RePack от Igruha" -> "RePack", "Portable", "P2P"
      label = (best.text.split("|")[1] || "")
        .replace(/&#039;|&#39;/g, "'")
        .replace(/<[^>]+>/g, "")
        .replace(/\s*от\s+.*/i, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    out.push({ id: dl.id, size, label });
  }
  return out;
}

/**
 * Build Hydra download entries from the working variants. The type label is
 * ALWAYS shown ("… [RePack]", "… [Portable]", "… [Архив]") — RePack vs Portable
 * is a real install-vs-unpack difference, so it matters even with one variant.
 * Duplicate titles (e.g. two variants of the same type) are disambiguated by
 * appending the size.
 * @param {{magnet: string, size: string, label: string}[]} working
 */
export function toDownloads(baseTitle, uploadDate, working) {
  const titled = working.map((v) => ({
    title: v.label ? `${baseTitle} [${v.label}]` : baseTitle,
    v,
  }));

  const counts = {};
  for (const t of titled) counts[t.title] = (counts[t.title] || 0) + 1;

  return titled.map(({ title, v }) => ({
    title: counts[title] > 1 && v.size ? `${title} (${v.size})` : title,
    uris: [v.magnet],
    uploadDate,
    fileSize: v.size,
  }));
}
