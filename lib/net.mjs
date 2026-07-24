/**
 * Shared network helpers for every generator — the "standard mixture".
 *
 * Why this exists: PlayGround once 503'd us into a rate-limit storm because its
 * generator used a weak retry (tries=2, flat backoff) and a hot pool (8). The
 * cure — retries with throttle-aware backoff, an abort timeout, a modest pool,
 * and a catalogue walk that tolerates a few failed pages — belongs in one place
 * so new generators get it for free instead of re-deriving (or forgetting) it.
 *
 * - fetch-based: getText / getJson (most sites)
 * - curl-based: getTextCurl (Cloudflare-fronted sites — undici's TLS fingerprint
 *   gets a 403; the system curl/Schannel is waved through)
 * - mapPool: bounded concurrency (keep <= 4 for detail pages; 8 self-throttles)
 * - decodeReversedB64: reversed-base64 fields (e.g. Tribo Gamer download params)
 */
import { execFile } from "node:child_process";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with an abort timeout — one dead socket must not hang the whole run. */
export async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Runs fn over items at a fixed concurrency, preserving result order. */
export async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/** Back off longer when throttled (429/5xx) so the site can breathe. */
const backoff = (message, t) => sleep(/(?:429|50\d)/.test(message) ? 1000 * t : 300);

export async function getText(url, { headers = {}, tries = 4, ms = 8000 } = {}) {
  for (let t = 1; ; t += 1) {
    try {
      const res = await fetchTimeout(url, { headers: { "User-Agent": UA, ...headers } }, ms);
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return res.text();
    } catch (err) {
      if (t >= tries) throw err;
      await backoff(err.message, t);
    }
  }
}

export async function getJson(url, { headers = {}, tries = 4, ms = 8000 } = {}) {
  for (let t = 1; ; t += 1) {
    try {
      const res = await fetchTimeout(
        url,
        { headers: { "User-Agent": UA, Accept: "application/json", ...headers } },
        ms
      );
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return res.json();
    } catch (err) {
      if (t >= tries) throw err;
      await backoff(err.message, t);
    }
  }
}

/**
 * Raw response bytes as a Buffer — for non-UTF-8 pages (Igruha is
 * windows-1251, decode with `new TextDecoder("windows-1251")`) and for binary
 * payloads like .torrent files.
 */
export async function getBuffer(url, { headers = {}, tries = 4, ms = 8000 } = {}) {
  for (let t = 1; ; t += 1) {
    try {
      const res = await fetchTimeout(url, { headers: { "User-Agent": UA, ...headers } }, ms);
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (t >= tries) throw err;
      await backoff(err.message, t);
    }
  }
}

/**
 * Cloudflare-fronted sites 403 Node's fetch (undici TLS fingerprint). The system
 * curl (Schannel on Windows) is waved through, so route those page fetches here.
 * Steam's API has no such block and keeps using getText/getJson.
 */
function curlOnce(url, ms) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-s", "-S", "-L", "-m", String(ms), "-A", UA, "-w", "\\n%{http_code}", url],
      { maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) return reject(err);
        const nl = stdout.lastIndexOf("\n");
        const status = Number(stdout.slice(nl + 1).trim());
        const body = stdout.slice(0, nl);
        if (!status || status >= 400) return reject(new Error(`GET ${url} -> ${status || "curl"}`));
        resolve(body);
      }
    );
  });
}

export async function getTextCurl(url, { tries = 4, ms = 25 } = {}) {
  for (let t = 1; ; t += 1) {
    try {
      return await curlOnce(url, ms);
    } catch (err) {
      if (t >= tries) throw err;
      await backoff(err.message, t);
    }
  }
}

/** Reversed-base64 field decode (reverse the string, then base64) — Tribo Gamer. */
export function decodeReversedB64(s) {
  try {
    return Buffer.from(decodeURIComponent(s).split("").reverse().join(""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Unified file-size label for a byte count — every source reads the same way,
 * picking the largest unit where the value is >= 1:
 *   >= 1 GB -> "2.42 GB", >= 1 MB -> "12.3 MB", >= 1 KB -> "391 KB",
 *   < 1 KB -> "512 B". Returns null for 0/invalid.
 */
export function formatBytes(n) {
  const bytes = Number(n);
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
  const mb = bytes / 1048576;
  if (mb >= 1) return `${mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const SIZE_UNIT_BYTES = {
  // Bytes: EN/RU + FR "o" (octet).
  b: 1, б: 1, o: 1,
  // Kilobytes.
  kb: 1024, кб: 1024, ko: 1024,
  // Megabytes.
  mb: 1048576, мб: 1048576, mo: 1048576,
  // Gigabytes.
  gb: 1073741824, гб: 1073741824, go: 1073741824,
  // Terabytes.
  tb: 1099511627776, тб: 1099511627776, to: 1099511627776,
};

/**
 * Normalizes ANY size value to the unified label: a byte count (number) or a
 * site string in any locale/format ("24.81 Мб", "35,5 MB", "767.22Kb",
 * "2.42 Гб") -> parsed to bytes -> formatBytes. Unparseable strings pass through.
 */
export function normalizeSize(value) {
  if (value == null) return null;
  if (typeof value === "number") return formatBytes(value);
  const str = String(value).trim();
  if (!str) return null;
  const m = str.match(/^([\d\s.,]+?)\s*([a-zа-я]+)\s*$/i);
  if (!m) return /^\d+$/.test(str) ? formatBytes(Number(str)) : str;
  const num = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  const mult = SIZE_UNIT_BYTES[m[2].toLowerCase()];
  if (!num || !mult) return str;
  return formatBytes(num * mult);
}
