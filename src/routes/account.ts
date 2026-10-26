import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cookieSecure } from "../config/env.js";
import type { AppContext } from "../context.js";
import { buildSessionCookie, clearSessionCookie } from "../modules/auth/cookies.js";
import { createSession, purgeExpiredSessions, revokeAllSessions, revokeSession } from "../modules/auth/sessions.js";
import { ChangePasswordSchema, changePassword, checkCredentials, deleteAccount, DeleteAccountSchema, LoginSchema, publicUser, registerUser, RegisterSchema } from "../modules/auth/service.js";
import { MIN_PASSWORD_LENGTH } from "../modules/auth/password.js";
import { AppError } from "../shared/errors.js";
import { getSession, requireSession } from "./auth.js";

function limit(res: { allowed: boolean; retryAfterSeconds: number }, what: string) {
  if (!res.allowed) throw new AppError("RATE_LIMITED", `Too many ${what}. Try again later.`, 429, { retryAfterSeconds: res.retryAfterSeconds });
}

export async function registerAccountRoutes(app: FastifyInstance, ctx: AppContext) {
  const secure = cookieSecure(ctx.config);
  const ttlSeconds = ctx.config.AUTH_SESSION_TTL_HOURS * 3600;

  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, mode: "cookie" | "token") {
    const { token, expiresAt } = await createSession(ctx.db, userId, { ttlHours: ctx.config.AUTH_SESSION_TTL_HOURS, userAgent: req.headers["user-agent"] as string | undefined });
    if (Math.random() < 0.02) void purgeExpiredSessions(ctx.db).catch(() => {}); // opportunistic cleanup
    if (mode === "cookie") reply.header("Set-Cookie", buildSessionCookie(token, { secure, maxAgeSeconds: ttlSeconds }));
    return { expiresAt, ...(mode === "token" ? { token } : {}) };
  }

  app.get("/api/v1/auth/config", async () => {
    return { registrationOpen: ctx.config.AUTH_ALLOW_REGISTRATION, passwordMinLength: MIN_PASSWORD_LENGTH, sessionTtlHours: ctx.config.AUTH_SESSION_TTL_HOURS, authMethods: ["cookie", "bearer"] };
  });

  app.post("/api/v1/auth/register", async (req, reply) => {
    limit(ctx.limiters.registerIp.hit(req.ip), "registrations from this address");
    const input = RegisterSchema.parse(req.body ?? {});
    const user = await registerUser(ctx, input);
    const session = await startSession(req, reply, user.id, input.mode);
    return reply.status(201).send({ user: publicUser(user), session });
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    limit(ctx.limiters.loginIp.hit(req.ip), "sign-in attempts from this address");
    const input = LoginSchema.parse(req.body ?? {});
    const failKey = `${input.email}|${req.ip}`;
    limit(ctx.limiters.loginFail.peek(failKey), "failed sign-in attempts for this account");
    const user = await checkCredentials(ctx, input.email, input.password);
    if (!user) {
      limit(ctx.limiters.loginFail.hit(failKey), "failed sign-in attempts for this account");
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password.", 401); // identical for unknown email / wrong password / disabled account
    }
    ctx.limiters.loginFail.reset(failKey);
    const session = await startSession(req, reply, user.id, input.mode);
    return { user: publicUser(user), session };
  });

  app.get("/api/v1/auth/me", async (req) => {
    const s = await requireSession(ctx, req);
    return { user: publicUser(s), session: { expiresAt: s.expiresAt } };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const s = await getSession(ctx, req);
    if (s) await revokeSession(ctx.db, s.tokenHash);
    reply.header("Set-Cookie", clearSessionCookie(secure));
    return reply.status(204).send();
  });

  app.post("/api/v1/auth/logout-all", async (req, reply) => {
    const s = await requireSession(ctx, req);
    const n = await revokeAllSessions(ctx.db, s.id);
    reply.header("Set-Cookie", clearSessionCookie(secure));
    return { revokedSessions: n };
  });

  app.post("/api/v1/auth/password", async (req) => {
    const s = await requireSession(ctx, req);
    limit(ctx.limiters.loginFail.hit(`pw|${s.id}`), "password change attempts");
    const input = ChangePasswordSchema.parse(req.body ?? {});
    await changePassword(ctx, s.id, input.currentPassword, input.newPassword);
    const revoked = await revokeAllSessions(ctx.db, s.id, s.tokenHash); // other devices must sign in again
    return { ok: true, otherSessionsRevoked: revoked };
  });

  app.delete("/api/v1/auth/account", async (req, reply) => {
    const s = await requireSession(ctx, req);
    limit(ctx.limiters.loginFail.hit(`del|${s.id}`), "account deletion attempts");
    const input = DeleteAccountSchema.parse(req.body ?? {});
    await deleteAccount(ctx, s.id, input.password);
    reply.header("Set-Cookie", clearSessionCookie(secure));
    return reply.status(204).send();
  });
}
