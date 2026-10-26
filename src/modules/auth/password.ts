import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/**
 * Password hashing with scrypt (memory-hard KDF, built into Node — no native dependency).
 * Stored format is self-describing so parameters can be raised later and old hashes upgraded on login:
 *     scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 */
export const KEYLEN = 64;
const R = 8;
const P = 1;
export const MAX_PASSWORD_LENGTH = 128; // bounds the work an attacker can force per request
export const MIN_PASSWORD_LENGTH = 10;

const maxmem = (N: number) => 128 * N * R * 2 + 1024 * 1024;

export async function hashPassword(password: string, log2N = 15): Promise<string> {
  const N = 2 ** log2N;
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N) });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export interface Parsed { N: number; r: number; p: number; salt: Buffer; hash: Buffer }
export function parseHash(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 10 || N > 2 ** 20 || r < 1 || p < 1) return null;
  return { N, r, p, salt: Buffer.from(parts[4]!, "base64"), hash: Buffer.from(parts[5]!, "base64") };
}

/** Constant-time verification. Returns false (never throws) for malformed stored hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || password.length > MAX_PASSWORD_LENGTH) return false;
  const derived = await scrypt(password.normalize("NFKC"), parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmem(parsed.N) });
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/** True if the stored hash used weaker parameters than the current target (rehash on next successful login). */
export function needsRehash(stored: string, log2N: number): boolean {
  const p = parseHash(stored);
  return !p || p.N < 2 ** log2N;
}

// A small list of the most common passwords (length-valid ones); a real deployment should use a breached-password service (e.g. k-anonymity range API).
const COMMON = new Set(
  ("password123 1234567890 qwertyuiop password1234 iloveyou123 letmein1234 welcome1234 admin12345 changeme123 passw0rd123 qwerty12345 1q2w3e4r5t abcdefghij abc1234567 11111111111 0123456789 987654321 123456789a password!1 p@ssw0rd123 football123 baseball123 monkey12345 dragon12345 sunshine123 princess123 trustno1234").split(/\s+/),
);

/** Returns human-readable problems; an empty array means the password is acceptable. */
export function passwordProblems(password: string, ctx: { email?: string; displayName?: string } = {}): string[] {
  const out: string[] = [];
  const pw = password.normalize("NFKC");
  if (pw.length < MIN_PASSWORD_LENGTH) out.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (pw.length > MAX_PASSWORD_LENGTH) out.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) out.push("That password is too common.");
  if (new Set(lower).size < 5) out.push("Password needs more variety of characters.");
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) out.push("Password must not contain your email name.");
  const name = ctx.displayName?.toLowerCase().replace(/\s+/g, "");
  if (name && name.length >= 4 && lower.replace(/\s+/g, "").includes(name)) out.push("Password must not contain your display name.");
  return out;
}
