// Minimal, dependency-free bencode decoder + .torrent -> magnet builder.
//
// Hydra only offers the Torrent downloader for URIs that start with "magnet:"
// (see getDownloadersForUri in the launcher's src/shared/index.ts); a plain
// .torrent URL yields no downloaders. Igruha exposes only a .torrent file, so
// we fetch it, compute the info-hash and assemble a magnet link ourselves.

import { createHash } from "node:crypto";

/**
 * Decode a bencoded buffer. Dictionary values are wrapped as
 * `{ val, start, end }` so we can recover the exact byte range of the `info`
 * dictionary (needed for the info-hash — it is the SHA-1 of those raw bytes).
 * List elements and the returned scalars are raw (Buffer | number | Array).
 */
function decode(buf) {
  let pos = 0;

  function parse() {
    const c = buf[pos];

    if (c === 0x69) {
      // i<int>e
      const end = buf.indexOf(0x65, pos);
      const n = parseInt(buf.toString("ascii", pos + 1, end), 10);
      pos = end + 1;
      return n;
    }

    if (c === 0x6c) {
      // l<items>e
      pos++;
      const arr = [];
      while (buf[pos] !== 0x65) arr.push(parse());
      pos++;
      return arr;
    }

    if (c === 0x64) {
      // d<pairs>e
      pos++;
      const obj = {};
      while (buf[pos] !== 0x65) {
        const key = parse(); // Buffer
        const valStart = pos;
        const val = parse();
        obj[key.toString("latin1")] = { val, start: valStart, end: pos };
      }
      pos++;
      return obj;
    }

    // <len>:<bytes>
    const colon = buf.indexOf(0x3a, pos);
    const len = parseInt(buf.toString("ascii", pos, colon), 10);
    const start = colon + 1;
    pos = start + len;
    return buf.subarray(start, pos);
  }

  return parse();
}

/**
 * @param {Buffer} buf raw .torrent bytes
 * @returns {{ infoHash: string, name: string, trackers: string[], magnet: string }}
 */
export function torrentToMagnet(buf) {
  const root = decode(buf);
  const info = root.info;
  if (!info) throw new Error("torrent has no info dictionary");

  const infoHash = createHash("sha1")
    .update(buf.subarray(info.start, info.end))
    .digest("hex");

  const name = info.val.name ? info.val.name.val.toString("utf8") : "";

  const trackers = new Set();
  if (root.announce) trackers.add(root.announce.val.toString("utf8"));
  if (root["announce-list"]) {
    for (const tier of root["announce-list"].val) {
      for (const t of tier) trackers.add(t.toString("utf8"));
    }
  }

  let magnet = `magnet:?xt=urn:btih:${infoHash}`;
  if (name) magnet += `&dn=${encodeURIComponent(name)}`;
  for (const tr of trackers) magnet += `&tr=${encodeURIComponent(tr)}`;

  return { infoHash, name, trackers: [...trackers], magnet };
}
