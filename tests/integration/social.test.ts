import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { AppContext } from "../../src/context.js";
import { registerUser } from "../../src/modules/auth/service.js";
import { dbAvailable, testContext, tokensFor } from "../helpers.js";

const ok = dbAvailable();
const PW = "tulip-orbit-lantern-92";
const J = { "content-type": "application/json" };

describe.skipIf(!ok)("relationships, posting and visibility (the inner circle in action)", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let H: Record<string, Record<string, string>>;
  let ids: Record<string, string>;
  const tag = `${Date.now()}`;
  const call = (method: string, url: string, who: string, body?: unknown) => app.inject({ method: method as "GET", url, headers: { ...J, ...H[who] }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  /** Search as `who` restricted to the throw-away city, lexical mode (deterministic). */
  const find = async (who: string) => {
    const r = (await call("POST", "/api/v1/search", who, { query: "quiet lanes brightly lit streets taxis lamp posts", mode: "lexical", generateAnswer: false, includeWeb: false, limit: 10, filters: { city: "Testville" } })).json();
    return r.candidates as { opinionId: string; channel: string }[];
  };
  const post = (who: string, visibility: string, text = "The quiet lanes were brightly lit by lamp posts and taxis waited right outside all night.") =>
    call("POST", "/api/v1/opinions", who, { text, city: "testville", category: "hotel_area", visibility, firsthand: true });

  beforeAll(async () => {
    ctx = await testContext();
    app = await buildApp(ctx, { serveUi: false });
    ids = {};
    for (const name of ["Ann", "Ben", "Cy"]) ids[name] = (await registerUser(ctx, { email: `${name.toLowerCase()}${tag}@test.example`, password: PW, displayName: `${name} Tester${tag}`, mode: "cookie" })).id;
    H = await tokensFor(ctx, Object.values(ids));
    // tokensFor is keyed by id; re-key by name for readability
    H = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, H[id]!]));
  });
  afterAll(async () => { await ctx.db.user.deleteMany({ where: { id: { in: Object.values(ids) } } }); await app.close(); await ctx.close(); });

  it("user search needs 3+ chars, excludes you, and only finds accounts that can sign in", async () => {
    expect((await call("GET", "/api/v1/users/search?q=ab", "Ann")).statusCode).toBe(400);
    const r = (await call("GET", `/api/v1/users/search?q=Tester${tag}`, "Ann")).json();
    expect(r.users.map((u: { displayName: string }) => u.displayName).sort()).toEqual([`Ben Tester${tag}`, `Cy Tester${tag}`]);
    const synthetic = (await call("GET", "/api/v1/users/search?q=Kabir", "Ann")).json();
    expect(synthetic.users).toEqual([]); // synthetic authors have no account => not discoverable
    expect(JSON.stringify(r)).not.toMatch(/email|password/i);
  });

  it("a pending request grants nothing; accepting it creates a connection; closeness decides the inner circle", async () => {
    await post("Ben", "INNER_CIRCLE");
    await post("Ben", "CONNECTIONS", "Ben also wrote that the quiet lanes were lit and taxis never stopped coming.");
    expect(await find("Ann")).toEqual([]);

    const req = await call("POST", "/api/v1/relationships", "Ann", { userId: ids.Ben, type: "FRIEND", closeness: 5 });
    expect(req.statusCode).toBe(201);
    expect(req.json().relationship).toMatchObject({ direction: "outgoing", status: "PENDING", innerCircle: false });
    expect(await find("Ann")).toEqual([]); // still pending: no access
    expect((await call("POST", "/api/v1/relationships", "Ann", { userId: ids.Ben })).statusCode).toBe(409); // duplicate

    const inbox = (await call("GET", "/api/v1/relationships", "Ben")).json();
    expect(inbox.incoming).toHaveLength(1);
    expect(inbox.incoming[0]).toMatchObject({ direction: "incoming", user: { id: ids.Ann } });
    expect((await call("POST", `/api/v1/relationships/${inbox.incoming[0].id}/accept`, "Ann")).statusCode).toBe(404); // only the addressee can accept

    const acc = await call("POST", `/api/v1/relationships/${inbox.incoming[0].id}/accept`, "Ben", { type: "FRIEND", closeness: 5 });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().relationship).toMatchObject({ status: "ACCEPTED", innerCircle: true });

    const seen = await find("Ann");
    expect(seen).toHaveLength(2);
    expect(new Set(seen.map((c) => c.channel))).toEqual(new Set(["inner_circle"])); // both opinions, labelled inner circle
    expect((await call("GET", "/api/v1/me/access", "Ann")).json().innerCircleIds).toEqual([ids.Ben]);
  });

  it("lowering closeness below the threshold removes INNER_CIRCLE-only opinions but keeps CONNECTIONS ones", async () => {
    const rel = (await call("GET", "/api/v1/relationships", "Ann")).json().friends[0];
    const p = await call("PATCH", `/api/v1/relationships/${rel.id}`, "Ann", { closeness: 2 });
    expect(p.json().relationship).toMatchObject({ closeness: 2, innerCircle: false });
    const seen = await find("Ann");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.channel).toBe("wider_social"); // still a connection, no longer inner circle
    await call("PATCH", `/api/v1/relationships/${rel.id}`, "Ann", { closeness: 4, type: "COLLEAGUE" });
    expect((await find("Ann")).length).toBe(1); // colleagues are never inner circle by default
    await call("PATCH", `/api/v1/relationships/${rel.id}`, "Ann", { type: "FAMILY" });
    expect((await find("Ann")).length).toBe(2);
  });

  it("strangers see only PUBLIC opinions; PRIVATE is never shared", async () => {
    await post("Ben", "PUBLIC", "Public note: quiet lanes, lamp posts lit all night and taxis lined up outside.");
    await post("Ben", "PRIVATE", "Private diary: the quiet lanes were lit by lamp posts and the taxis were fine.");
    const cy = await find("Cy");
    expect(cy).toHaveLength(1);
    const mine = (await call("GET", "/api/v1/opinions/mine", "Ben")).json().opinions;
    expect(mine.map((o: { visibility: string }) => o.visibility).sort()).toEqual(["CONNECTIONS", "INNER_CIRCLE", "PRIVATE", "PUBLIC"]);
    const ann = await find("Ann");
    expect(ann).toHaveLength(3); // her connection sees inner, connections and public, never private
  });

  it("lets users edit only their own opinions and refreshes derived text metadata", async () => {
    const created = await call("POST", "/api/v1/opinions", "Ann", {
      text: "The hotel lane was dark and noisy after midnight, with no taxis nearby.",
      city: `Editville${tag}`,
      category: "hotel_area",
      visibility: "PRIVATE",
      firsthand: false,
      rating: 2,
    });
    expect(created.statusCode).toBe(201);
    const opinionId = created.json().opinion.id;
    const updated = await call("PATCH", `/api/v1/opinions/${opinionId}`, "Ann", {
      text: "I stayed by the hotel lane; it was brightly lit and taxis waited outside.",
      city: `Editville${tag}`,
      neighborhood: "Central",
      category: "hotel_area",
      visibility: "PUBLIC",
      firsthand: true,
      rating: 5,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().opinion).toMatchObject({
      id: opinionId,
      text: "I stayed by the hotel lane; it was brightly lit and taxis waited outside.",
      neighborhood: "Central",
      visibility: "PUBLIC",
      firsthand: true,
      rating: 5,
    });
    expect(updated.json().aspects.some((a: { aspect: string }) => a.aspect === "lighting")).toBe(true);

    expect((await call("PATCH", `/api/v1/opinions/${opinionId}`, "Ben", {
      text: "This other user should not be able to edit the opinion.",
      city: `Editville${tag}`,
      category: "hotel_area",
    })).statusCode).toBe(404);
    expect((await call("PATCH", `/api/v1/opinions/${opinionId}`, "Ann", {
      text: "too short",
      city: `Editville${tag}`,
      category: "hotel_area",
    })).statusCode).toBe(400);
  });

  it("blocking hides the blocked user's content (even PUBLIC) and prevents contact; unblocking restores it", async () => {
    expect((await call("POST", "/api/v1/blocks", "Ann", { userId: ids.Ben })).statusCode).toBe(204);
    expect(await find("Ann")).toEqual([]);
    const list = (await call("GET", "/api/v1/relationships", "Ann")).json();
    expect(list.friends).toEqual([]);
    expect(list.blocked).toHaveLength(1);
    expect((await call("POST", "/api/v1/relationships", "Ben", { userId: ids.Ann })).statusCode).toBe(404); // Ben cannot even tell why
    expect((await call("GET", `/api/v1/users/search?q=Tester${tag}`, "Ben")).json().users.map((u: { id: string }) => u.id)).not.toContain(ids.Ann);
    expect((await call("DELETE", `/api/v1/blocks/${ids.Ben}`, "Ann")).statusCode).toBe(204);
    const afterBlock = await find("Ann");
    expect(afterBlock).toHaveLength(1); // only PUBLIC now: the connection was destroyed by the block
  });

  it("decline, cancel and remove delete the relationship; reverse requests auto-accept", async () => {
    const r1 = (await call("POST", "/api/v1/relationships", "Cy", { userId: ids.Ann })).json().relationship;
    expect((await call("POST", `/api/v1/relationships/${r1.id}/decline`, "Ann")).statusCode).toBe(204);
    expect((await call("GET", "/api/v1/relationships", "Cy")).json().outgoing).toEqual([]);
    const r2 = (await call("POST", "/api/v1/relationships", "Cy", { userId: ids.Ann })).json().relationship;
    expect((await call("DELETE", `/api/v1/relationships/${r2.id}`, "Cy")).statusCode).toBe(204); // cancel own request
    await call("POST", "/api/v1/relationships", "Cy", { userId: ids.Ann, closeness: 4 });
    const back = await call("POST", "/api/v1/relationships", "Ann", { userId: ids.Cy, closeness: 4 });
    expect(back.statusCode).toBe(200);
    expect(back.json().autoAccepted).toBe(true);
    const friend = (await call("GET", "/api/v1/relationships", "Ann")).json().friends[0];
    expect((await call("DELETE", `/api/v1/relationships/${friend.id}`, "Ben")).statusCode).toBe(404); // not a party
    expect((await call("DELETE", `/api/v1/relationships/${friend.id}`, "Ann")).statusCode).toBe(204);
    expect((await call("POST", "/api/v1/relationships", "Ann", { userId: ids.Ann })).statusCode).toBe(400); // self
    expect((await call("POST", "/api/v1/relationships", "Ann", { userId: "u_does_not_exist" })).statusCode).toBe(404);
    expect((await call("POST", "/api/v1/relationships", "Ann", { userId: ids.Cy, bogus: 1 })).statusCode).toBe(400);
  });

  it("posting an opinion: validated, aspect-tagged, city-canonicalised, embedded; deletable only by its author", async () => {
    expect((await call("POST", "/api/v1/opinions", "Ann", { text: "too short", city: "Mumbai", category: "cafe" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/opinions", "Ann", { text: "x".repeat(2001), city: "Mumbai", category: "cafe" })).statusCode).toBe(400);
    expect((await call("POST", "/api/v1/opinions", "Ann", { text: "A valid length opinion about quiet lit streets.", city: "Mumbai", category: "Bad Category!" })).statusCode).toBe(400);
    const future = new Date(Date.now() + 5 * 86400000).toISOString();
    expect((await call("POST", "/api/v1/opinions", "Ann", { text: "A valid length opinion about quiet lit streets.", city: "Mumbai", category: "cafe", writtenAt: future })).statusCode).toBe(400);

    const r = await call("POST", "/api/v1/opinions", "Ann", { text: "Walking back at midnight the road was brightly lit and taxis were easy to find near the station.", city: "mumbai", category: "hotel_area", visibility: "PUBLIC", firsthand: true });
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.opinion.city).toBe("Mumbai"); // reuses the corpus spelling so location filters line up
    expect(j.aspects.map((a: { aspect: string }) => a.aspect)).toEqual(expect.arrayContaining(["lighting", "transport"]));
    expect(j.embedding).toBe("stored"); // test-hash provider is configured in this context
    const row = await ctx.db.opinion.findUniqueOrThrow({ where: { id: j.opinion.id } });
    expect(row).toMatchObject({ provenanceSource: "user-generated", isSynthetic: false, sourceType: "SOCIAL_USER", authorId: ids.Ann });

    expect((await call("DELETE", `/api/v1/opinions/${j.opinion.id}`, "Ben")).statusCode).toBe(404);
    expect((await call("DELETE", "/api/v1/opinions/op_m01", "Ann")).statusCode).toBe(404); // seeded synthetic data is not deletable via the API
    expect((await call("DELETE", `/api/v1/opinions/${j.opinion.id}`, "Ann")).statusCode).toBe(204);
    expect(await ctx.db.opinion.count({ where: { id: j.opinion.id } })).toBe(0);
  });

  it("an embedding-provider outage never loses the post", async () => {
    const c2 = await testContext({ embedding: false });
    const a2 = await buildApp(c2, { serveUi: false });
    try {
      const r = await a2.inject({ method: "POST", url: "/api/v1/opinions", headers: { ...J, ...H.Ann }, payload: JSON.stringify({ text: "The lane behind the hotel was dark and nobody was around after midnight.", city: "Testville", category: "hotel_area", visibility: "PRIVATE" }) });
      expect(r.statusCode).toBe(201);
      expect(r.json().embedding).toBe("skipped");
    } finally { await a2.close(); await c2.close(); }
  });

  it("write endpoints are rate limited", async () => {
    const c3 = await testContext({ embedding: false, config: { RATE_LIMIT_ENABLED: "true", RATE_LIMIT_WRITE_PER_MIN: "2" } });
    const a3 = await buildApp(c3, { serveUi: false });
    try {
      const send = () => a3.inject({ method: "POST", url: "/api/v1/opinions", headers: { ...J, ...H.Cy }, payload: JSON.stringify({ text: "Another opinion about lit streets and taxis at night in town.", city: "Testville", category: "hotel_area", visibility: "PRIVATE" }) });
      expect((await send()).statusCode).toBe(201);
      expect((await send()).statusCode).toBe(201);
      const third = await send();
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    } finally { await a3.close(); await c3.close(); }
  });
});
