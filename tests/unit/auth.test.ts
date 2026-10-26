import { describe, expect, it } from "vitest";
import { buildSessionCookie, clearSessionCookie, cookieName, parseCookies } from "../../src/modules/auth/cookies.js";
import { hashPassword, MAX_PASSWORD_LENGTH, needsRehash, parseHash, passwordProblems, verifyPassword } from "../../src/modules/auth/password.js";
import { NoLimiter, RateLimiter } from "../../src/modules/auth/rate-limit.js";
import { generateToken, hashToken, looksLikeToken, TOKEN_PREFIX } from "../../src/modules/auth/sessions.js";
import { allowRestrictedData, cookieSecure, loadConfig } from "../../src/config/env.js";

describe("password hashing (scrypt)", () => {
  it("produces a self-describing, salted hash and verifies only the right password", async () => {
    const h = await hashPassword("correct horse battery staple", 10);
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
    // Same password, different salt => different hash
    expect(await hashPassword("correct horse battery staple", 10)).not.toBe(h);
  });
  it("never throws on malformed stored hashes or oversized input", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$5$8$1$AAAA$BBBB")).toBe(false); // N too small
    expect(await verifyPassword("a".repeat(MAX_PASSWORD_LENGTH + 1), await hashPassword("y".repeat(12), 10))).toBe(false);
    expect(parseHash("scrypt$1024$8$1$AAAA")).toBeNull();
  });
  it("flags weaker parameters for rehash on next login", async () => {
    const weak = await hashPassword("some long password 1", 10);
    expect(needsRehash(weak, 15)).toBe(true);
    expect(needsRehash(weak, 10)).toBe(false);
    expect(needsRehash("garbage", 10)).toBe(true);
  });
  it("normalises Unicode so visually identical passwords match", async () => {
    const h = await hashPassword("caf\u00e9-password-1", 10); // precomposed é
    expect(await verifyPassword("cafe\u0301-password-1", h)).toBe(true); // decomposed é
  });
});

describe("password policy", () => {
  it("accepts a reasonable passphrase", () => {
    expect(passwordProblems("tulip-orbit-lantern-92", { email: "a@b.co" })).toEqual([]);
  });
  it("rejects short, common, low-variety and personal passwords", () => {
    expect(passwordProblems("short1")).toHaveLength(1);
    expect(passwordProblems("password123")).not.toEqual([]);
    expect(passwordProblems("aaaaaaaaaaaaaa").join(" ")).toMatch(/variety/);
    expect(passwordProblems("riyasharma-2026!x", { email: "riyasharma@example.com" }).join(" ")).toMatch(/email/);
    expect(passwordProblems("My name is Riya Sharma", { displayName: "Riya Sharma" }).join(" ")).toMatch(/display name/);
    expect(passwordProblems("x".repeat(MAX_PASSWORD_LENGTH + 1)).join(" ")).toMatch(/at most/);
  });
});

describe("session tokens", () => {
  it("are long random prefixed strings; only a SHA-256 is meant to be stored", () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(looksLikeToken(t)).toBe(true);
    expect(t).not.toBe(generateToken());
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(hashToken(t)).toBe(hashToken(t));
  });
  it("rejects obviously invalid tokens before touching the database", () => {
    for (const bad of ["", "abc", "sos_", "sos_short", "x".repeat(60), "sos_" + "a".repeat(200)]) expect(looksLikeToken(bad)).toBe(false);
  });
});

describe("cookies", () => {
  it("parses a cookie header, ignoring malformed pairs and keeping the first value", () => {
    expect(parseCookies("a=1; b=hello%20world; c; d=%E0%A4%A; a=2")).toEqual({ a: "1", b: "hello world" });
    expect(parseCookies(undefined)).toEqual({});
  });
  it("builds a hardened session cookie", () => {
    const plain = buildSessionCookie("tok", { secure: false, maxAgeSeconds: 3600 });
    expect(plain).toBe("sos_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600");
    const secure = buildSessionCookie("tok", { secure: true, maxAgeSeconds: 60 });
    expect(secure.startsWith("__Host-sos_session=tok")).toBe(true);
    expect(secure).toMatch(/Secure/);
    expect(secure).toMatch(/HttpOnly/);
    expect(secure).not.toMatch(/Domain=/); // required by the __Host- prefix
    expect(cookieName(true)).toBe("__Host-sos_session");
  });
  it("clears the cookie with Max-Age=0", () => {
    expect(clearSessionCookie(false)).toMatch(/Max-Age=0/);
  });
});

describe("rate limiter", () => {
  it("allows up to max hits per window, reports Retry-After, then resets", () => {
    let now = 1_000;
    const rl = new RateLimiter(3, 10_000, () => now);
    expect([1, 2, 3].map(() => rl.hit("k").allowed)).toEqual([true, true, true]);
    const blocked = rl.hit("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(10);
    expect(rl.hit("other").allowed).toBe(true); // keys are independent
    now += 10_001;
    expect(rl.hit("k").allowed).toBe(true); // window rolled over
  });
  it("peek does not consume budget; reset clears a key", () => {
    const rl = new RateLimiter(1, 10_000, () => 0);
    expect(rl.peek("k").allowed).toBe(true);
    rl.hit("k");
    expect(rl.peek("k").allowed).toBe(false);
    rl.reset("k");
    expect(rl.peek("k").allowed).toBe(true);
  });
  it("NoLimiter always allows", () => {
    const n = new NoLimiter();
    for (let i = 0; i < 100; i++) expect(n.hit("k").allowed).toBe(true);
  });
});

describe("auth-related configuration", () => {
  const base = { DATABASE_URL: "postgresql://x" } as NodeJS.ProcessEnv;
  it("defaults: secure cookies and restricted-data hiding only in production", () => {
    const dev = loadConfig({ ...base });
    expect(cookieSecure(dev)).toBe(false);
    expect(allowRestrictedData(dev)).toBe(true);
    const prod = loadConfig({ ...base, NODE_ENV: "production" });
    expect(cookieSecure(prod)).toBe(true);
    expect(allowRestrictedData(prod)).toBe(false);
    expect(allowRestrictedData(loadConfig({ ...base, NODE_ENV: "production", DATASET_ALLOW_RESTRICTED: "true" }))).toBe(true);
    expect(cookieSecure(loadConfig({ ...base, NODE_ENV: "production", AUTH_COOKIE_SECURE: "false" }))).toBe(false);
  });
  it("validates ranges", () => {
    expect(() => loadConfig({ ...base, AUTH_SCRYPT_LOG2N: "5" })).toThrow();
    expect(() => loadConfig({ ...base, AUTH_SESSION_TTL_HOURS: "0" })).toThrow();
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
  });
});
