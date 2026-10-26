import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { Prisma } from "../db/client.js";
import { upsertEmbedding } from "../db/embeddings-store.js";
import { extractAspects } from "../modules/query-understanding/aspects.js";
import { isInnerCircle, innerCircleRule } from "../modules/social-access/access.js";
import { AppError } from "../shared/errors.js";
import { requireUser } from "./auth.js";

const RelType = z.enum(["FRIEND", "FAMILY", "COLLEAGUE", "ACQUAINTANCE"]);
const Closeness = z.number().int().min(1).max(5);
const id = z.string().min(1).max(64);

const SendRequest = z
  .object({ userId: id.optional(), email: z.string().trim().toLowerCase().email().max(254).optional(), type: RelType.default("FRIEND"), closeness: Closeness.default(3) })
  .strict()
  .refine((x) => x.userId || x.email, "Provide userId or email");
const AcceptBody = z.object({ type: RelType.optional(), closeness: Closeness.optional() }).strict();
const PatchBody = z.object({ type: RelType.optional(), closeness: Closeness.optional() }).strict().refine((x) => x.type || x.closeness, "Provide type or closeness");
const BlockBody = z.object({ userId: id }).strict();

const CreateOpinion = z
  .object({
    text: z.string().trim().min(20, "Write at least 20 characters").max(2000, "At most 2000 characters"),
    city: z.string().trim().min(2).max(80),
    neighborhood: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().toLowerCase().regex(/^[a-z_]{2,40}$/, "Use lowercase letters/underscores, e.g. hotel_area, cafe, restaurant"),
    firsthand: z.boolean().default(true),
    visibility: z.enum(["PUBLIC", "CONNECTIONS", "INNER_CIRCLE", "PRIVATE"]).default("CONNECTIONS"),
    rating: z.number().int().min(1).max(5).optional(),
    writtenAt: z.string().datetime().optional(),
  })
  .strict();
const UpdateOpinion = CreateOpinion.omit({ writtenAt: true });

const MAX_OPINIONS_PER_USER = 500;
const titleCase = (s: string) => s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());

export async function registerSocialRoutes(app: FastifyInstance, ctx: AppContext) {
  const rule = innerCircleRule(ctx.config);
  const writeLimit = (userId: string) => {
    const r = ctx.limiters.write.hit(userId);
    if (!r.allowed) throw new AppError("RATE_LIMITED", "Too many changes. Slow down.", 429, { retryAfterSeconds: r.retryAfterSeconds });
  };

  /** Rows between two users in either direction. */
  const between = (a: string, b: string) => ctx.db.relationship.findMany({ where: { OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] } });

  const view = (r: { id: string; requesterId: string; addresseeId: string; status: string; type: string; closeness: number; createdAt: Date; acceptedAt: Date | null }, me: string, names: Map<string, string>) => {
    const otherId = r.requesterId === me ? r.addresseeId : r.requesterId;
    return {
      id: r.id,
      user: { id: otherId, displayName: names.get(otherId) ?? "Unknown" },
      direction: r.requesterId === me ? "outgoing" : "incoming",
      status: r.status,
      type: r.type,
      closeness: r.closeness,
      /** True only when the configured inner-circle rule is met (ACCEPTED + type + closeness). */
      innerCircle: isInnerCircle(r, rule),
      createdAt: r.createdAt,
      acceptedAt: r.acceptedAt,
    };
  };

  // ------------------------------------------------------------------ user search
  app.get("/api/v1/users/search", async (req) => {
    const me = await requireUser(ctx, req);
    const q = z.object({ q: z.string().trim().min(3, "Type at least 3 characters").max(60) }).parse(req.query).q;
    const r = ctx.limiters.search.hit(`usersearch|${me}`);
    if (!r.allowed) throw new AppError("RATE_LIMITED", "Too many searches.", 429, { retryAfterSeconds: r.retryAfterSeconds });
    const blocks = await ctx.db.relationship.findMany({ where: { status: "BLOCKED", OR: [{ requesterId: me }, { addresseeId: me }] }, select: { requesterId: true, addresseeId: true } });
    const hidden = new Set(blocks.flatMap((b) => [b.requesterId, b.addresseeId]));
    // Only accounts that can sign in are discoverable; synthetic authors and public-dataset pseudonyms are not.
    const users = await ctx.db.user.findMany({
      where: { email: { not: null }, isActive: true, id: { notIn: [me, ...hidden] }, displayName: { contains: q, mode: "insensitive" } },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
      take: 10,
    });
    const rels = users.length ? await ctx.db.relationship.findMany({ where: { OR: users.flatMap((u) => [{ requesterId: me, addresseeId: u.id }, { requesterId: u.id, addresseeId: me }]) } }) : [];
    return {
      users: users.map((u) => {
        const rel = rels.find((x) => x.requesterId === u.id || x.addresseeId === u.id);
        return { id: u.id, displayName: u.displayName, relationship: !rel ? "none" : rel.status === "ACCEPTED" ? "connected" : rel.requesterId === me ? "request_sent" : "request_received" };
      }),
    };
  });

  // ------------------------------------------------------------------ relationships
  app.get("/api/v1/relationships", async (req) => {
    const me = await requireUser(ctx, req);
    const rows = await ctx.db.relationship.findMany({ where: { OR: [{ requesterId: me }, { addresseeId: me }] }, orderBy: { createdAt: "desc" } });
    const ids = [...new Set(rows.flatMap((r) => [r.requesterId, r.addresseeId]))].filter((x) => x !== me);
    const names = new Map((await ctx.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
    const mk = (r: (typeof rows)[number]) => view(r, me, names);
    return {
      innerCircleDefinition: { requires: "ACCEPTED", types: rule.types, minCloseness: rule.minCloseness },
      friends: rows.filter((r) => r.status === "ACCEPTED").map(mk),
      incoming: rows.filter((r) => r.status === "PENDING" && r.addresseeId === me).map(mk),
      outgoing: rows.filter((r) => r.status === "PENDING" && r.requesterId === me).map(mk),
      blocked: rows.filter((r) => r.status === "BLOCKED" && r.requesterId === me).map(mk), // who blocked *me* is never revealed
    };
  });

  app.post("/api/v1/relationships", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const body = SendRequest.parse(req.body ?? {});
    const target = await ctx.db.user.findFirst({
      where: { isActive: true, email: { not: null }, ...(body.userId ? { id: body.userId } : { email: body.email }) },
      select: { id: true, displayName: true },
    });
    if (target?.id === me) throw new AppError("INVALID_REQUEST", "You cannot connect with yourself.", 400);
    const existing = target ? await between(me, target.id) : [];
    // Unknown user, or someone who blocked/was blocked: indistinguishable from the outside.
    if (!target || existing.some((r) => r.status === "BLOCKED")) throw new AppError("USER_NOT_FOUND", "No such user.", 404);
    if (existing.some((r) => r.status === "ACCEPTED")) throw new AppError("ALREADY_CONNECTED", "You are already connected.", 409);
    if (existing.some((r) => r.requesterId === me)) throw new AppError("REQUEST_PENDING", "A request is already pending.", 409);
    const names = new Map([[target.id, target.displayName]]);
    const reverse = existing.find((r) => r.requesterId === target.id && r.status === "PENDING");
    if (reverse) {
      // They already asked us: sending a request back accepts theirs.
      const r = await ctx.db.relationship.update({ where: { id: reverse.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), closeness: body.closeness, type: body.type } });
      return reply.status(200).send({ relationship: view(r, me, names), autoAccepted: true });
    }
    const r = await ctx.db.relationship.create({ data: { id: `rel_${randomBytes(8).toString("hex")}`, requesterId: me, addresseeId: target.id, type: body.type, status: "PENDING", closeness: body.closeness } });
    return reply.status(201).send({ relationship: view(r, me, names), autoAccepted: false });
  });

  const loadMine = async (relId: string, me: string) => {
    const r = await ctx.db.relationship.findUnique({ where: { id: relId } });
    if (!r || (r.requesterId !== me && r.addresseeId !== me)) throw new AppError("NOT_FOUND", "Relationship not found.", 404);
    return r;
  };
  const namesFor = async (r: { requesterId: string; addresseeId: string }, me: string) => {
    const other = r.requesterId === me ? r.addresseeId : r.requesterId;
    const u = await ctx.db.user.findUnique({ where: { id: other }, select: { displayName: true } });
    return new Map([[other, u?.displayName ?? "Unknown"]]);
  };

  app.post<{ Params: { id: string } }>("/api/v1/relationships/:id/accept", async (req) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const body = AcceptBody.parse(req.body ?? {});
    const r = await loadMine(req.params.id, me);
    if (r.status !== "PENDING" || r.addresseeId !== me) throw new AppError("NOT_FOUND", "No pending request to accept.", 404);
    const u = await ctx.db.relationship.update({ where: { id: r.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), ...(body.type ? { type: body.type } : {}), ...(body.closeness ? { closeness: body.closeness } : {}) } });
    return { relationship: view(u, me, await namesFor(u, me)) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/relationships/:id/decline", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const r = await loadMine(req.params.id, me);
    if (r.status !== "PENDING" || r.addresseeId !== me) throw new AppError("NOT_FOUND", "No pending request to decline.", 404);
    await ctx.db.relationship.delete({ where: { id: r.id } });
    return reply.status(204).send();
  });

  app.patch<{ Params: { id: string } }>("/api/v1/relationships/:id", async (req) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const body = PatchBody.parse(req.body ?? {});
    const r = await loadMine(req.params.id, me);
    if (r.status !== "ACCEPTED") throw new AppError("NOT_FOUND", "Only accepted connections can be edited.", 404);
    const u = await ctx.db.relationship.update({ where: { id: r.id }, data: { ...(body.type ? { type: body.type } : {}), ...(body.closeness ? { closeness: body.closeness } : {}) } });
    return { relationship: view(u, me, await namesFor(u, me)) };
  });

  // Remove a connection or cancel a request I sent.
  app.delete<{ Params: { id: string } }>("/api/v1/relationships/:id", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const r = await loadMine(req.params.id, me);
    if (r.status === "BLOCKED") throw new AppError("NOT_FOUND", "Use DELETE /api/v1/blocks/:userId to unblock.", 404);
    await ctx.db.relationship.delete({ where: { id: r.id } });
    return reply.status(204).send();
  });

  app.post("/api/v1/blocks", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const { userId } = BlockBody.parse(req.body ?? {});
    if (userId === me) throw new AppError("INVALID_REQUEST", "You cannot block yourself.", 400);
    const target = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!target) throw new AppError("USER_NOT_FOUND", "No such user.", 404);
    await ctx.db.$transaction([
      ctx.db.relationship.deleteMany({ where: { OR: [{ requesterId: me, addresseeId: userId }, { requesterId: userId, addresseeId: me }] } }),
      ctx.db.relationship.create({ data: { id: `rel_${randomBytes(8).toString("hex")}`, requesterId: me, addresseeId: userId, type: "ACQUAINTANCE", status: "BLOCKED", closeness: 1 } }),
    ]);
    return reply.status(204).send();
  });

  app.delete<{ Params: { userId: string } }>("/api/v1/blocks/:userId", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    await ctx.db.relationship.deleteMany({ where: { requesterId: me, addresseeId: req.params.userId, status: "BLOCKED" } });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------ my opinions
  app.post("/api/v1/opinions", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const body = CreateOpinion.parse(req.body ?? {});
    const writtenAt = body.writtenAt ? new Date(body.writtenAt) : new Date();
    if (writtenAt.getTime() > Date.now() + 60_000) throw new AppError("VALIDATION_ERROR", "writtenAt cannot be in the future.", 400);
    if ((await ctx.db.opinion.count({ where: { authorId: me } })) >= MAX_OPINIONS_PER_USER) throw new AppError("LIMIT_REACHED", `You can store at most ${MAX_OPINIONS_PER_USER} opinions.`, 409);

    // Reuse the corpus's spelling of a city if it exists ("mumbai" -> "Mumbai"), so location filters line up.
    const known = await ctx.db.$queryRaw<{ city: string }[]>(Prisma.sql`SELECT city FROM opinions WHERE lower(city) = lower(${body.city}) LIMIT 1`);
    const city = known[0]?.city ?? titleCase(body.city);
    const opinionId = `op_u_${randomBytes(8).toString("hex")}`;
    await ctx.db.opinion.create({
      data: {
        id: opinionId, authorId: me, text: body.text, city, neighborhood: body.neighborhood ? titleCase(body.neighborhood) : null, category: body.category, writtenAt,
        sourceType: "SOCIAL_USER", firsthand: body.firsthand, visibility: body.visibility, rating: body.rating ?? null,
        provenanceSource: "user-generated", provenanceNote: "Written by a registered user of this application.", isSynthetic: false,
      },
    });
    const aspects = extractAspects(body.text);
    if (aspects.length) await ctx.db.opinionAspect.createMany({ data: aspects.map((a) => ({ opinionId, aspect: a.aspect, polarity: a.polarity, matchedTerms: a.matchedTerms, extractor: "lexicon-v1" })) });

    // Best effort: embed so semantic retrieval can find it. A provider failure never loses the opinion.
    let embedding: "stored" | "skipped" | "failed" = "skipped";
    if (ctx.embedding) {
      try {
        const [v] = await ctx.embedding.embed([body.text], { inputType: "document", timeoutMs: ctx.config.PROVIDER_TIMEOUT_MS });
        await upsertEmbedding(ctx.db, opinionId, ctx.embedding.modelKey, v!);
        embedding = "stored";
      } catch { embedding = "failed"; }
    }
    return reply.status(201).send({
      opinion: { id: opinionId, text: body.text, city, neighborhood: body.neighborhood ?? null, category: body.category, firsthand: body.firsthand, visibility: body.visibility, rating: body.rating ?? null, writtenAt },
      aspects: aspects.map((a) => ({ aspect: a.aspect, polarity: a.polarity })),
      embedding,
      note: embedding === "failed" ? "Saved, but semantic indexing failed; run `npm run embeddings:index` to retry." : undefined,
    });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/opinions/:id", async (req) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const body = UpdateOpinion.parse(req.body ?? {});
    const existing = await ctx.db.opinion.findFirst({
      where: { id: req.params.id, authorId: me, provenanceSource: "user-generated" },
      select: { id: true },
    });
    if (!existing) throw new AppError("NOT_FOUND", "Opinion not found.", 404);

    const known = await ctx.db.$queryRaw<{ city: string }[]>(Prisma.sql`SELECT city FROM opinions WHERE lower(city) = lower(${body.city}) LIMIT 1`);
    const city = known[0]?.city ?? titleCase(body.city);
    const neighborhood = body.neighborhood ? titleCase(body.neighborhood) : null;
    const aspects = extractAspects(body.text);
    await ctx.db.$transaction(async (tx) => {
      await tx.opinion.update({
        where: { id: existing.id },
        data: {
          text: body.text,
          city,
          neighborhood,
          category: body.category,
          firsthand: body.firsthand,
          visibility: body.visibility,
          rating: body.rating ?? null,
        },
      });
      await tx.opinionAspect.deleteMany({ where: { opinionId: existing.id, extractor: "lexicon-v1" } });
      if (aspects.length) {
        await tx.opinionAspect.createMany({
          data: aspects.map((a) => ({ opinionId: existing.id, aspect: a.aspect, polarity: a.polarity, matchedTerms: a.matchedTerms, extractor: "lexicon-v1" })),
        });
      }
      await tx.opinionEmbedding.deleteMany({ where: { opinionId: existing.id } });
    });

    let embedding: "stored" | "skipped" | "failed" = "skipped";
    if (ctx.embedding) {
      try {
        const [v] = await ctx.embedding.embed([body.text], { inputType: "document", timeoutMs: ctx.config.PROVIDER_TIMEOUT_MS });
        await upsertEmbedding(ctx.db, existing.id, ctx.embedding.modelKey, v!);
        embedding = "stored";
      } catch (err) {
        app.log.warn({ err, opinionId: existing.id }, "Opinion updated but semantic indexing failed.");
        embedding = "failed";
      }
    }
    return {
      opinion: { id: existing.id, text: body.text, city, neighborhood, category: body.category, firsthand: body.firsthand, visibility: body.visibility, rating: body.rating ?? null },
      aspects: aspects.map((a) => ({ aspect: a.aspect, polarity: a.polarity })),
      embedding,
      note: embedding === "failed" ? "Updated, but semantic indexing failed; run `npm run embeddings:index` to retry." : undefined,
    };
  });

  app.get("/api/v1/opinions/mine", async (req) => {
    const me = await requireUser(ctx, req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const rows = await ctx.db.opinion.findMany({ where: { authorId: me }, orderBy: { writtenAt: "desc" }, take: q.limit, include: { source: { select: { id: true, name: true } } } });
    return { opinions: rows.map((o) => ({ id: o.id, text: o.text, city: o.city, neighborhood: o.neighborhood, category: o.category, firsthand: o.firsthand, visibility: o.visibility, rating: o.rating, writtenAt: o.writtenAt, source: o.source })) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/opinions/:id", async (req, reply) => {
    const me = await requireUser(ctx, req);
    writeLimit(me);
    const r = await ctx.db.opinion.deleteMany({ where: { id: req.params.id, authorId: me, provenanceSource: "user-generated" } });
    if (r.count === 0) throw new AppError("NOT_FOUND", "Opinion not found.", 404);
    return reply.status(204).send();
  });
}
