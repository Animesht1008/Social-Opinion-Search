/**
 * Downloads pretrained GloVe vectors (gensim-data release of glove-wiki-gigaword-<dim>) and converts the
 * top-N most frequent words into the compact binary format read by src/modules/embeddings/glove.ts.
 *
 *   Source : https://github.com/RaRe-Technologies/gensim-data/releases (tag glove-wiki-gigaword-100)
 *   Origin : Stanford GloVe 6B (Wikipedia 2014 + Gigaword 5), https://nlp.stanford.edu/projects/glove/
 *   Licence: Public Domain Dedication and License v1.0 (PDDL). Cite Pennington, Socher & Manning, EMNLP 2014.
 *
 * Usage: npm run embeddings:glove [-- --dim 100 --top 100000]
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GLOVE_MAGIC } from "../src/modules/embeddings/glove.js";

const args = process.argv.slice(2);
const arg = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const dim = arg("dim", 100);
const top = arg("top", 100000);
const url = `https://github.com/RaRe-Technologies/gensim-data/releases/download/glove-wiki-gigaword-${dim}/glove-wiki-gigaword-${dim}.gz`;
const out = `data/models/glove-wiki-gigaword-${dim}.sos.bin`;

mkdirSync("data/models", { recursive: true });
console.log(`Downloading ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) {
  console.error(`Download failed: HTTP ${res.status}. If your network blocks github.com, download the file manually and gunzip it into ${out}.txt.`);
  process.exit(1);
}
const gunzip = createGunzip();
const rl = createInterface({ input: Readable.fromWeb(res.body as any).pipe(gunzip), crlfDelay: Infinity });

const chunks: Buffer[] = [];
let count = 0;
let first = true;
for await (const line of rl) {
  if (first) {
    first = false;
    if (/^\d+ \d+$/.test(line.trim())) continue; // word2vec header "N D"
  }
  if (count >= top) break;
  const parts = line.split(" ");
  const word = parts[0]!;
  if (parts.length !== dim + 1) continue;
  if (!/^[a-z0-9]+$/.test(word)) continue; // keep plain lowercase alphanumeric tokens only
  const w = Buffer.from(word, "utf8");
  const rec = Buffer.alloc(2 + w.length + dim * 4);
  rec.writeUInt16LE(w.length, 0);
  w.copy(rec, 2);
  for (let d = 0; d < dim; d++) rec.writeFloatLE(Number(parts[d + 1]), 2 + w.length + d * 4);
  chunks.push(rec);
  count++;
}
rl.close();
const header = Buffer.alloc(13);
header.write(GLOVE_MAGIC, 0, "latin1");
header.writeUInt32LE(dim, 5);
header.writeUInt32LE(count, 9);
writeFileSync(out, Buffer.concat([header, ...chunks]));
console.log(`Wrote ${out}: ${count} words x ${dim} dims (${(Buffer.concat(chunks).length / 1e6).toFixed(1)} MB)`);
