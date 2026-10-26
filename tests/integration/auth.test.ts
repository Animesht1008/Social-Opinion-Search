import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import { DEMO_PASSWORD, dbAvailable, testContext } from "../helpers.js";

const ok = dbAvailable();
const PW = "tulip-orbit-lantern-92";
const JSONH = { "content-type": "application/json" };
let n = 0;
const email = () => `auth${Date.now()}${++n}@test.example`;

type R = Awaited<ReturnType<FastifyInstance["inject"]>>;
const cookieOf = (r: R): { name: string; value: string; raw: string } | null => {
  const sc = r.headers["set-cookie"];
  const raw = Array.isArray(sc) ? sc[0] : sc;
  if (!raw) return null;
  const [pair] = raw.split(";");
  const i = pair!.indexOf("=");
  return { name: pair!.slice(0, i), value: decodeURIComponent(pair!.slice(i + 1)), raw };
};

describe.skipIf(!ok)("authentication lifecycle", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { ...JSONH, ...headers }, payload: JSON.stringify(body) });
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
  const register = async (e = email(), extra: Record<string, unknown> = {}) => {
    const res = await post("/api/v1/auth/register", { email: e, password: PW, displayName: "Test Person", ...extra });
    return { res, email: e, json: res.json(), cookie: cookieOf(res) };
  };

  beforeAll(async () => { ctx = await testContext({ embedding: false }); app = await buildApp(ctx, { serveUi: false }); });
  afterAll(async () => { await ctx.db.user.deleteMany({ where: { email: { endsWith: "@test.example" } } }); await app.close(); await ctx.close(); });

  it("register creates an account, sets an HttpOnly SameSite=Lax cookie, and never returns secrets", async () => {
    const { res, json, cookie } = await register();
    expect(res.statusCode).toBe(201);
    expect(cookie!.name).toBe("sos_session");
    expect(cookie!.raw).toMatch(/HttpOnly/);
    expect(cookie!.raw).toMatch(/SameSite=Lax/);
    expect(cookie!.raw).toMatch(/Path=\//);
    expect(cookie!.raw).not.toMatch(/Secure/); // test env is plain http
    expect(json.user).toMatchObject({ displayName: "Test Person" });
    expect(JSON.stringify(json)).not.toMatch(/password|hash|scrypt/i);
    expect(json.session.token).toBeUndefined(); // cookie mode: the token is never in the body
    const me = await get("/api/v1/auth/me", { cookie: `${cookie!.name}=${cookie!.value}` });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(json.user.email);
  });

  it("stores a scrypt hash (not the password) and only the SHA-256 of the session token", async () => {
    const { json, cookie } = await register();
    const u = await ctx.db.user.findUniqueOrThrow({ where: { id: json.user.id } });
    expect(u.passwordHash).toMatch(/^scrypt\$/);
    expect(u.passwordHash).not.toContain(PW);
    const rows = await ctx.db.session.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash("sha256").update(cookie!.value).digest("hex"));
    expect(rows[0]!.tokenHash).not.toBe(cookie!.value);
  });

  it("token mode returns a bearer token for API clients (and sets no cookie)", async () => {
    const e = email();
    const r = await post("/api/v1/auth/register", { email: e, password: PW, displayName: "Api Client", mode: "token" });
    expect(r.statusCode).toBe(201);
    expect(cookieOf(r)).toBeNull();
    const token = r.json().session.token as string;
    expect(token).toMatch(/^sos_/);
    expect((await get("/api/v1/auth/me", { authorization: `Bearer ${token}` })).statusCode).toBe(200);
    expect((await get("/api/v1/auth/me", { authorization: `Bearer ${token}x` })).statusCode).toBe(401);
  });

  it("validates input: weak password, bad email, duplicate (case-insensitive), unknown fields", async () => {
    const e = email();
    expect((await register(e)).res.statusCode).toBe(201);
    const dup = await post("/api/v1/auth/register", { email: e.toUpperCase(), password: PW, displayName: "Dup" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EMAIL_TAKEN");
    const weak = await post("/api/v1/auth/register", { email: email(), password: "password123", displayName: "Weak" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe("WEAK_PASSWORD");
    expect((await post("/api/v1/auth/register", { email: "nope", password: PW, displayName: "X Y" })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/register", { email: email(), password: PW, displayName: "X Y", isAdmin: true })).statusCode).toBe(400);
    expect((await post("/api/v1/auth/register", { email: email(), password: PW, displayName: "<b>x</b>" })).statusCode).toBe(400);
  });

  it("login: success updates lastLoginAt; failures are indistinguishable (unknown email vs wrong password)", async () => {
    const { email: e, json } = await register();
    const okRes = await post("/api/v1/auth/login", { email: e.toUpperCase(), password: PW });
    expect(okRes.statusCode).toBe(200);
    expect(cookieOf(okRes)).not.toBeNull();
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: json.user.id } })).lastLoginAt).not.toBeNull();
    const wrong = await post("/api/v1/auth/login", { email: e, password: "wrong-password-123" });
    const unknown = await post("/api/v1/auth/login", { email: "nobody@test.example", password: "wrong-password-123" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("logout revokes the session server-side; it is idempotent", async () => {
    const { cookie } = await register();
    const h = { cookie: `${cookie!.name}=${cookie!.value}` };
    const out = await post("/api/v1/auth/logout", {}, h);
    expect(out.statusCode).toBe(204);
    expect(out.headers["set-cookie"]).toMatch(/Max-Age=0/);
    expect((await get("/api/v1/auth/me", h)).statusCode).toBe(401); // token is dead even though the client still has it
    expect((await post("/api/v1/auth/logout", {})).statusCode).toBe(204);
  });

  it("logout-all revokes every session of the user", async () => {
    const { email: e, cookie } = await register();
    const second = cookieOf(await post("/api/v1/auth/login", { email: e, password: PW }))!;
    expect((await post("/api/v1/auth/logout-all", {}, { cookie: `${cookie!.name}=${cookie!.value}` })).json().revokedSessions).toBe(2);
    expect((await get("/api/v1/auth/me", { cookie: `${second.name}=${second.value}` })).statusCode).toBe(401);
  });

  it("expired sessions and disabled accounts are rejected", async () => {
    const { json, cookie } = await register();
    const h = { cookie: `${cookie!.name}=${cookie!.value}` };
    await ctx.db.session.updateMany({ where: { userId: json.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get("/api/v1/auth/me", h)).statusCode).toBe(401);
    const b = await register();
    await ctx.db.user.update({ where: { id: b.json.user.id }, data: { isActive: false } });
    expect((await get("/api/v1/auth/me", { cookie: `${b.cookie!.name}=${b.cookie!.value}` })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: b.email, password: PW })).statusCode).toBe(401);
  });

  it("change password: needs the current one, revokes other sessions, keeps this one", async () => {
    const { email: e, cookie } = await register();
    const other = cookieOf(await post("/api/v1/auth/login", { email: e, password: PW }))!;
    const h = { cookie: `${cookie!.name}=${cookie!.value}` };
    expect((await post("/api/v1/auth/password", { currentPassword: "not-my-password", newPassword: "another-long-pass-77" }, h)).statusCode).toBe(401);
    expect((await post("/api/v1/auth/password", { currentPassword: PW, newPassword: "short" }, h)).json().error.code).toBe("WEAK_PASSWORD");
    const ch = await post("/api/v1/auth/password", { currentPassword: PW, newPassword: "another-long-pass-77" }, h);
    expect(ch.statusCode).toBe(200);
    expect(ch.json().otherSessionsRevoked).toBe(1);
    expect((await get("/api/v1/auth/me", h)).statusCode).toBe(200);
    expect((await get("/api/v1/auth/me", { cookie: `${other.name}=${other.value}` })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: e, password: PW })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: e, password: "another-long-pass-77" })).statusCode).toBe(200);
  });

  it("delete account needs the password and cascades to the user's data", async () => {
    const { email: e, json, cookie } = await register();
    const h = { cookie: `${cookie!.name}=${cookie!.value}` };
    await ctx.db.opinion.create({ data: { id: "op_u_authdel", authorId: json.user.id, text: "A throw-away opinion about lit streets and taxis at night.", city: "Testville", category: "hotel_area", writtenAt: new Date(), sourceType: "SOCIAL_USER", firsthand: true, visibility: "PRIVATE", provenanceSource: "user-generated" } });
    const wrong = await app.inject({ method: "DELETE", url: "/api/v1/auth/account", headers: { ...JSONH, ...h }, payload: JSON.stringify({ password: "nope-nope-nope-1" }) });
    expect(wrong.statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: "/api/v1/auth/account", headers: { ...JSONH, ...h }, payload: JSON.stringify({ password: PW }) });
    expect(del.statusCode).toBe(204);
    expect(await ctx.db.user.count({ where: { id: json.user.id } })).toBe(0);
    expect(await ctx.db.opinion.count({ where: { id: "op_u_authdel" } })).toBe(0);
    expect(await ctx.db.session.count({ where: { userId: json.user.id } })).toBe(0);
    expect((await post("/api/v1/auth/login", { email: e, password: PW })).statusCode).toBe(401);
  });

  it("the old x-user-id header no longer authenticates anything", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/search", headers: { ...JSONH, "x-user-id": "u_riya" }, payload: JSON.stringify({ query: "dark streets" }) });
    expect(r.statusCode).toBe(401);
    for (const url of ["/api/v1/auth/me", "/api/v1/opinions", "/api/v1/relationships", "/api/v1/me/access", "/api/v1/opinions/mine", "/api/v1/users/search?q=abc"]) {
      expect((await get(url, { "x-user-id": "u_riya" })).statusCode, url).toBe(401);
    }
    expect((await get("/api/v1/users")).statusCode).toBe(404); // the demo user directory is gone
  });

  it("sends hardening headers (CSP, nosniff, no-store for API)", async () => {
    const r = await get("/api/v1/auth/config");
    expect(r.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(r.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(r.headers["content-security-policy"]).not.toMatch(/unsafe-inline/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["strict-transport-security"]).toBeUndefined();
  });

  it("CSRF: cookie-authenticated writes from another origin are blocked; same-origin and bearer calls pass", async () => {
    const { cookie } = await register();
    const c = { cookie: `${cookie!.name}=${cookie!.value}` };
    const evil = await post("/api/v1/auth/logout-all", {}, { ...c, origin: "https://evil.example" });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe("CSRF_BLOCKED");
    expect((await post("/api/v1/auth/logout-all", {}, { ...c, "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    const same = await post("/api/v1/auth/logout-all", {}, { ...c, origin: "http://localhost:80" });
    expect(same.statusCode).toBe(200);
    const t = await post("/api/v1/auth/register", { email: email(), password: PW, displayName: "Bearer User", mode: "token" });
    const bearer = await post("/api/v1/auth/logout-all", {}, { authorization: `Bearer ${t.json().session.token}`, origin: "https://elsewhere.example" });
    expect(bearer.statusCode).toBe(200); // bearer tokens are not ambient credentials
  });

  it("does not expose demo accounts in public bootstrap config; seeded accounts can still sign in directly", async () => {
    const cfg = await get("/api/v1/auth/config");
    expect(cfg.json()).not.toHaveProperty("demoAccounts");
    const login = await post("/api/v1/auth/login", { email: "riya@gmail.com", password: DEMO_PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe("u_riya");
    const c = cookieOf(login)!;
    const s = await post("/api/v1/search", { query: "dark streets in Mumbai at night", mode: "lexical", generateAnswer: false }, { cookie: `${c.name}=${c.value}` });
    expect(s.statusCode).toBe(200);
    expect(s.json().requester.id).toBe("u_riya");
    expect(s.json().selected.some((e: { channel: string }) => e.channel === "inner_circle")).toBe(true);
  });
});

describe.skipIf(!ok)("abuse protection and deployment modes", () => {
  it("locks out repeated failed logins for an account (429 + Retry-After), even with the right password", async () => {
    const ctx = await testContext({ embedding: false, config: { RATE_LIMIT_ENABLED: "true" } });
    const app = await buildApp(ctx, { serveUi: false });
    const e = email();
    try {
      await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: JSONH, payload: JSON.stringify({ email: e, password: PW, displayName: "Lock Test" }) });
      const login = (password: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: JSONH, payload: JSON.stringify({ email: e, password }) });
      for (let i = 0; i < 5; i++) expect((await login("definitely-wrong-1")).statusCode).toBe(401);
      const blocked = await login(PW);
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.json().error.code).toBe("RATE_LIMITED");
    } finally { await ctx.db.user.deleteMany({ where: { email: e } }); await app.close(); await ctx.close(); }
  });
  it("registration can be closed", async () => {
    const ctx = await testContext({ embedding: false, config: { AUTH_ALLOW_REGISTRATION: "false" } });
    const app = await buildApp(ctx, { serveUi: false });
    try {
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: JSONH, payload: JSON.stringify({ email: email(), password: PW, displayName: "Closed" }) });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("REGISTRATION_CLOSED");
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json().registrationOpen).toBe(false);
    } finally { await app.close(); await ctx.close(); }
  });
  it("secure mode: __Host- cookie with Secure flag and HSTS", async () => {
    const ctx = await testContext({ embedding: false, config: { AUTH_COOKIE_SECURE: "true" } });
    const app = await buildApp(ctx, { serveUi: false });
    const e = email();
    try {
      const r = await app.inject({ method: "POST", url: "/api/v1/auth/register", headers: JSONH, payload: JSON.stringify({ email: e, password: PW, displayName: "Secure Mode" }) });
      const c = cookieOf(r)!;
      expect(c.name).toBe("__Host-sos_session");
      expect(c.raw).toMatch(/; Secure/);
      expect(r.headers["strict-transport-security"]).toMatch(/max-age=/);
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: `${c.name}=${c.value}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: `sos_session=${c.value}` } })).statusCode).toBe(401); // wrong cookie name is ignored
    } finally { await ctx.db.user.deleteMany({ where: { email: e } }); await app.close(); await ctx.close(); }
  });
  it("search is rate limited per user", async () => {
    const ctx = await testContext({ embedding: false, config: { RATE_LIMIT_ENABLED: "true", RATE_LIMIT_SEARCH_PER_MIN: "2" } });
    const app = await buildApp(ctx, { serveUi: false });
    try {
      const { tokensFor } = await import("../helpers.js");
      const A = await tokensFor(ctx, ["u_zoya"]);
      const s = () => app.inject({ method: "POST", url: "/api/v1/search", headers: { ...JSONH, ...A.u_zoya }, payload: JSON.stringify({ query: "dark streets", mode: "lexical", generateAnswer: false }) });
      expect((await s()).statusCode).toBe(200);
      expect((await s()).statusCode).toBe(200);
      expect((await s()).statusCode).toBe(429);
    } finally { await app.close(); await ctx.close(); }
  });
});
