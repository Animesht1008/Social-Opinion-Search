import type { FastifyRequest } from "fastify";
import { cookieSecure } from "../config/env.js";
import type { AppContext } from "../context.js";
import { cookieName, parseCookies } from "../modules/auth/cookies.js";
import { lookupSession, type SessionUser } from "../modules/auth/sessions.js";
import { AppError } from "../shared/errors.js";

/**
 * Request authentication. Accepts either
 *   - the HttpOnly session cookie (browser UI), or
 *   - `Authorization: Bearer sos_...` (API/CLI clients that logged in with mode "token").
 * Sessions are opaque server-side tokens (see modules/auth/sessions.ts). There is no header-based identity any more.
 */
const cache = new WeakMap<FastifyRequest, SessionUser | null>();

export function extractToken(req: FastifyRequest, secure: boolean): { token: string; via: "bearer" | "cookie" } | null {
  const h = req.headers.authorization;
  if (typeof h === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (m) return { token: m[1]!, via: "bearer" };
  }
  const c = parseCookies(req.headers.cookie)[cookieName(secure)];
  return c ? { token: c, via: "cookie" } : null;
}

export async function getSession(ctx: AppContext, req: FastifyRequest): Promise<SessionUser | null> {
  if (cache.has(req)) return cache.get(req)!;
  const t = extractToken(req, cookieSecure(ctx.config));
  // Sessions always use the real clock (REFERENCE_DATE only pins ranking/eval time).
  const s = t ? await lookupSession(ctx.db, t.token, new Date()) : null;
  cache.set(req, s);
  return s;
}

export async function requireSession(ctx: AppContext, req: FastifyRequest): Promise<SessionUser> {
  const s = await getSession(ctx, req);
  if (!s) throw new AppError("UNAUTHENTICATED", "Sign in required.", 401);
  return s;
}

/** Kept for route code that only needs the user id. */
export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<string> {
  return (await requireSession(ctx, req)).id;
}
