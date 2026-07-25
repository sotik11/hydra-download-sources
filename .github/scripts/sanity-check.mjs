/**
 * Sanity-check the live feeds (candidate = `main`) against the last known-good
 * snapshot (baseline = `snapshot` branch) before promoting main -> snapshot.
 *
 * Per data/*.json, all must hold or the snapshot is skipped:
 *   - valid JSON with a non-empty `downloads` array
 *   - every uri is a magnet: link            (>= MAGNET_MIN of entries)
 *   - count(candidate)  >= COUNT_MIN of baseline   (guards against a gutted run)
 *   - fileSize(candidate) >= SIZE_MIN of baseline  (guards against truncation)
 *
 * Usage: node sanity-check.mjs <candidate-data-dir> <baseline-data-dir>
 * Exit 0 + "OK:" lines on pass; exit 1 + "FAIL:" lines otherwise.
 * Writes a JSON summary to $GITHUB_OUTPUT for the Telegram notifier.
 */
import { readdirSync, readFileSync, statSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const CAND = process.argv[2];
const BASE = process.argv[3];
if (!CAND || !BASE) {
  console.error("Usage: node sanity-check.mjs <candidate-dir> <baseline-dir>");
  process.exit(2);
}

const COUNT_MIN = 0.9;
const MAGNET_MIN = 0.95;
const SIZE_MIN = 0.5;
const MAGNET = /^magnet:\?xt=urn:btih:[0-9a-f]{40}/i;

const files = readdirSync(CAND).filter((f) => f.endsWith(".json"));
const failures = [];
const successes = [];

for (const file of files) {
  const candPath = join(CAND, file);
  const basePath = join(BASE, file);

  let doc;
  try {
    doc = JSON.parse(readFileSync(candPath, "utf8"));
  } catch (e) {
    failures.push(`${file}: invalid JSON (${e.message})`);
    continue;
  }
  const dl = doc.downloads;
  if (!Array.isArray(dl) || dl.length === 0) {
    failures.push(`${file}: empty or missing downloads[]`);
    continue;
  }

  const magnets = dl.filter((e) => MAGNET.test(e?.uris?.[0] ?? "")).length;
  const magnetRatio = magnets / dl.length;
  if (magnetRatio < MAGNET_MIN) {
    failures.push(
      `${file}: only ${(magnetRatio * 100).toFixed(1)}% magnet uris (< ${MAGNET_MIN * 100}%)`
    );
    continue;
  }

  const candSize = statSync(candPath).size;
  let countRatio = 1;
  let sizeRatio = 1;
  if (existsSync(basePath)) {
    let baseDoc;
    try {
      baseDoc = JSON.parse(readFileSync(basePath, "utf8"));
    } catch {
      baseDoc = { downloads: [] };
    }
    const baseCount = Array.isArray(baseDoc.downloads) ? baseDoc.downloads.length : 0;
    const baseSize = statSync(basePath).size;
    if (baseCount > 0) countRatio = dl.length / baseCount;
    if (baseSize > 0) sizeRatio = candSize / baseSize;

    if (countRatio < COUNT_MIN) {
      failures.push(
        `${file}: count ${dl.length} < ${COUNT_MIN * 100}% of snapshot ${baseCount}`
      );
      continue;
    }
    if (sizeRatio < SIZE_MIN) {
      failures.push(
        `${file}: size ${candSize} < ${SIZE_MIN * 100}% of snapshot ${baseSize}`
      );
      continue;
    }
  }

  successes.push({
    file,
    count: dl.length,
    magnetRatio: magnetRatio.toFixed(3),
    countRatio: countRatio.toFixed(2),
  });
}

const ok = failures.length === 0;
for (const s of successes) console.log(`OK: ${s.file} (${s.count} games, magnets ${s.magnetRatio})`);
for (const f of failures) console.log(`FAIL: ${f}`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `ok=${ok}\n`);
  appendFileSync(out, `failures=${failures.join(" | ")}\n`);
}

process.exit(ok ? 0 : 1);
