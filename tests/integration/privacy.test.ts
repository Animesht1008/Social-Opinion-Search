import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import { Prisma } from "../../src/db/client.js";
import { authorizationSql, canViewOpinion, loadAccessContext } from "../../src/modules/social-access/access.js";
import { dbAvailable, testContext, tokensFor } from "../helpers.js";

const ok = dbAvailable();

// Opinions that carry the most "tempting" content for the queries below but must be invisible to the named requester.
const SENSITIVE_QUERY = "Colaba lanes dark unlit nobody around followed after midnight";
const NOT_FOR_RIYA: Record<string, string> = {
  op_m31: "pending relationship (Tara, CONNECTIONS)",
  op_m32: "pending relationship (Neel, CONNECTIONS)",
  op_m33: "blocked user (Vik, PUBLIC)",
  op_m34: "PRIVATE (Kabir)",
  op_m35: "INNER_CIRCLE of a user who is only a low-closeness connection (Dev)",
  op_m36: "unrelated user (Ishaan, CONNECTIONS)",
  op_m37: "unrelated user (Pooja, CONNECTIONS)",
};

let A: Record<string, Record<string, string>> = {};
const BOGUS = { authorization: `Bearer sos_${"x".repeat(43)}` };
async function post(app: FastifyInstance, user: string | undefined, body: unknown) {
  return app.inject({ method: "POST", url: "/api/v1/search", headers: { ...(user ? (A[user] ?? BOGUS) : {}), "content-type": "application/json" }, payload: JSON.stringify(body) });
}

describe.skipIf(!ok)("privacy & authorization", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  beforeAll(async () => { ctx = await testContext(); app = await buildApp(ctx, { serveUi: false }); A = await tokensFor(ctx, ["u_riya", "u_aman", "u_zoya", "u_kabir"]); });
  afterAll(async () => { await app.close(); await ctx.close(); });

  const everyId = (r: any) => new Set<string>([...r.selected.map((s: any) => s.opinionId), ...r.candidates.map((c: any) => c.opinionId), ...r.suppressedDuplicates.map((s: any) => s.id)]);

  it("Riya never receives pending / blocked / private / non-inner-circle opinions in any mode, ranking mode, or evidence-limit", async () => {
    for (const mode of ["lexical", "semantic", "hybrid"]) {
      for (const ranking of ["relevance_first", "social_aware"]) {
        const res = await post(app, "u_riya", { query: SENSITIVE_QUERY, mode, ranking, limit: 10, candidatePool: 200 });
        expect(res.statusCode).toBe(200);
        const r = res.json();
        const ids = everyId(r);
        for (const bad of Object.keys(NOT_FOR_RIYA)) expect(ids.has(bad), `${bad} (${NOT_FOR_RIYA[bad]}) leaked in ${mode}/${ranking}`).toBe(false);
        const raw = res.body;
        expect(raw).not.toContain("two men followed us"); // text of op_m31
        expect(raw).not.toContain("Private note to self"); // text of op_m34
      }
    }
  });
  it("accepted-but-different graphs see different evidence: Aman (Tara is accepted family) can see what Riya cannot", async () => {
    const r = (await post(app, "u_aman", { query: SENSITIVE_QUERY, mode: "lexical", limit: 10, candidatePool: 200 })).json();
    const ids = everyId(r);
    expect(ids.has("op_m31")).toBe(true); // Tara's CONNECTIONS opinion
    expect(ids.has("op_m35")).toBe(true); // Dev's INNER_CIRCLE opinion (Aman-Dev closeness 5)
    expect(ids.has("op_m34")).toBe(false); // still PRIVATE
    expect(r.candidates.find((c: any) => c.opinionId === "op_m31").channel).toBe("inner_circle"); // Tara is FAMILY closeness 5
  });
  it("Zoya (no relationships) only ever sees PUBLIC opinions", async () => {
    const r = (await post(app, "u_zoya", { query: "dark streets nobody around hotel night lit taxis", mode: "hybrid", limit: 10, candidatePool: 200 })).json();
    const ids = [...everyId(r)];
    expect(ids.length).toBeGreaterThan(5);
    const rows = await ctx.db.opinion.findMany({ where: { id: { in: ids } }, select: { id: true, visibility: true } });
    expect(rows.every((o) => o.visibility === "PUBLIC")).toBe(true);
    expect(r.candidates.every((c: any) => c.channel === "wider_social")).toBe(true);
  });
  it("a user's own opinions are never returned as social evidence", async () => {
    const r = (await post(app, "u_kabir", { query: "Colaba lit taxis walking back", mode: "lexical", limit: 10, candidatePool: 200 })).json();
    expect(r.candidates.some((c: any) => c.authorId === "u_kabir")).toBe(false);
  });
  it("SQL authorization predicate is equivalent to the pure canViewOpinion for every user and every opinion", async () => {
    const users = await ctx.db.user.findMany({ select: { id: true } });
    const all = await ctx.db.opinion.findMany({ select: { id: true, authorId: true, visibility: true } });
    for (const u of users) {
      const a = await loadAccessContext(ctx.db, u.id, ctx.circleRule);
      const rows = await ctx.db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT o.id FROM opinions o WHERE ${authorizationSql(a)}`);
      const sqlSet = new Set(rows.map((r) => r.id));
      const jsSet = new Set(all.filter((o) => canViewOpinion(a, o as any)).map((o) => o.id));
      expect(sqlSet, `mismatch for ${u.id}`).toEqual(jsSet);
    }
  });
  it("GET /opinions applies the same access rules and paginates", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 30; guard++) {
      const res: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: "GET", url: `/api/v1/opinions?limit=15${cursor ? `&cursor=${cursor}` : ""}`, headers: A.u_riya });
      expect(res.statusCode).toBe(200);
      const j: { opinions: { id: string }[]; nextCursor: string | null } = res.json();
      seen.push(...j.opinions.map((o: any) => o.id));
      cursor = j.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBeGreaterThan(50);
    expect(new Set(seen).size).toBe(seen.length);
    for (const bad of Object.keys(NOT_FOR_RIYA)) expect(seen).not.toContain(bad);
    expect(seen).toContain("op_m01"); // Kabir, inner circle
    const zoya = (await app.inject({ method: "GET", url: "/api/v1/opinions?limit=50&city=Mumbai", headers: A.u_zoya })).json();
    expect(zoya.opinions.every((o: any) => o.visibility === "PUBLIC")).toBe(true);
  });
  it("search runs are private to their owner (404 for others) and contain no opinion text", async () => {
    const r = (await post(app, "u_riya", { query: "Colaba lit taxis at night" , generateAnswer: true })).json();
    const own = await app.inject({ method: "GET", url: `/api/v1/search-runs/${r.runId}`, headers: A.u_riya });
    expect(own.statusCode).toBe(200);
    for (const s of r.selected) expect(own.body).not.toContain(s.text.slice(0, 30));
    for (const other of ["u_zoya", "u_aman", "u_kabir"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/search-runs/${r.runId}`, headers: A[other] });
      expect(res.statusCode).toBe(404);
    }
    expect((await app.inject({ method: "GET", url: `/api/v1/search-runs/${r.runId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/search-runs/not-a-uuid", headers: A.u_riya })).statusCode).toBe(400);
  });
  it("evaluation summary (a debug-style endpoint) exposes ids and metrics only, never opinion text", async () => {
    await ctx.db.evaluationRun.create({ data: { id: "00000000-0000-4000-8000-000000000001", config: {}, summary: { note: "x" }, perQuery: [{ ranked: [{ id: "op_m01", grade: 3 }] }] } });
    const res = await app.inject({ method: "GET", url: "/api/v1/evaluation/summary", headers: A.u_riya });
    expect(res.statusCode).toBe(200);
    await ctx.db.evaluationRun.delete({ where: { id: "00000000-0000-4000-8000-000000000001" } });
    const texts = (await ctx.db.opinion.findMany({ select: { text: true } })).map((o) => o.text.slice(0, 30));
    for (const t of texts) expect(res.body).not.toContain(t);
  });
  it("authentication: missing or unknown user ids are rejected", async () => {
    expect((await post(app, undefined, { query: "dark streets" })).statusCode).toBe(401);
    expect((await post(app, "u_nobody", { query: "dark streets" })).statusCode).toBe(401);
    expect((await post(app, "x".repeat(200), { query: "dark streets" })).statusCode).toBe(401);
  });
});
