import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../db/client.js";

/**
 * Opaque server-side sessions.
 *  - token  : 32 random bytes (256 bits) base64url, prefixed "sos_" so leaked tokens are recognisable in secret scanners.
 *  - storage: only SHA-256(token) is stored. A database leak therefore does not reveal usable tokens
 *             (SHA-256 is appropriate here because the token is high-entropy random, unlike a password).
 *  - revocation is a row delete; expiry is checked on every lookup.
 */
export const TOKEN_PREFIX = "sos_";
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const generateToken = (): string => TOKEN_PREFIX + randomBytes(32).toString("base64url");
export const looksLikeToken = (t: string): boolean => t.startsWith(TOKEN_PREFIX) && t.length >= 40 && t.length <= 80;

export interface SessionUser {
  id: string;
  displayName: string;
  email: string | null;
  tokenHash: string;
  expiresAt: Date;
}

export async function createSession(db: Db, userId: string, opts: { ttlHours: number; userAgent?: string | null; now?: Date }): Promise<{ token: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + opts.ttlHours * 3600_000);
  await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt, lastUsedAt: now, userAgent: opts.userAgent?.slice(0, 200) ?? null } });
  return { token, expiresAt };
}

/** Returns the signed-in user for a token, or null if it is unknown, expired, or the account is disabled. */
export async function lookupSession(db: Db, token: string, now = new Date()): Promise<SessionUser | null> {
  if (!looksLikeToken(token)) return null;
  const tokenHash = hashToken(token);
  const s = await db.session.findUnique({ where: { tokenHash }, include: { user: { select: { id: true, displayName: true, email: true, isActive: true } } } });
  if (!s || s.expiresAt <= now || !s.user.isActive) {
    if (s && s.expiresAt <= now) await db.session.delete({ where: { tokenHash } }).catch(() => {});
    return null;
  }
  if (now.getTime() - s.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) await db.session.update({ where: { tokenHash }, data: { lastUsedAt: now } }).catch(() => {});
  return { id: s.user.id, displayName: s.user.displayName, email: s.user.email, tokenHash, expiresAt: s.expiresAt };
}

export async function revokeSession(db: Db, tokenHash: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash } });
}

export async function revokeAllSessions(db: Db, userId: string, exceptTokenHash?: string): Promise<number> {
  const r = await db.session.deleteMany({ where: { userId, ...(exceptTokenHash ? { tokenHash: { not: exceptTokenHash } } : {}) } });
  return r.count;
}

export async function purgeExpiredSessions(db: Db, now = new Date()): Promise<number> {
  return (await db.session.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
