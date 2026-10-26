/**
 * Convenience downloader for a file you are entitled to fetch (you give the URL).
 *   npm run dataset:download -- --url https://example.org/file.csv --out data/datasets/raw/file.csv [--max-mb 500]
 * Prints the SHA-256 so you can record it. Does not unzip. Does not bypass any access controls.
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "./_args.js";

const { values } = parseArgs(process.argv.slice(2));
const url = values.get("url")?.[0], out = values.get("out")?.[0];
const maxBytes = Number(values.get("max-mb")?.[0] ?? 500) * 1024 * 1024;
if (!url || !out) { console.error("Usage: --url <https URL> --out <path> [--max-mb N]"); process.exit(2); }
if (!/^https:\/\//.test(url)) { console.error("Only https:// URLs are accepted."); process.exit(2); }
mkdirSync(dirname(out), { recursive: true });
const res = await fetch(url, { redirect: "follow" });
if (!res.ok || !res.body) { console.error(`HTTP ${res.status} from ${url}`); process.exit(1); }
const hash = createHash("sha256");
let bytes = 0;
const meter = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; if (bytes > maxBytes) return cb(new Error(`Aborted: exceeds --max-mb (${maxBytes / 1048576} MB)`)); hash.update(chunk); cb(null, chunk); } });
await pipeline(Readable.fromWeb(res.body as any), meter, createWriteStream(out));
console.log(`Saved ${out} (${(bytes / 1048576).toFixed(1)} MB)\nSHA-256: ${hash.digest("hex")}`);
