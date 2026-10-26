import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { AppError } from "../../shared/errors.js";
import { hashPassword, MAX_PASSWORD_LENGTH, needsRehash, passwordProblems, verifyPassword } from "./password.js";

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();

const displayName = z
  .string()
  .trim()
  .min(2, "Display name must be at least 2 characters")
  .max(60, "Display name must be at most 60 characters")
  .refine((s) => !/[\u0000-\u001f\u007f<>]/.test(s), "Display name contains invalid characters");

const email = z.string().trim().max(254).email("Enter a valid email address").transform(normalizeEmail);
const password = z.string().max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
const mode = z.enum(["cookie", "token"]).default("cookie");

export const RegisterSchema = z.object({ email, password, displayName, mode }).strict();
export const LoginSchema = z.object({ email, password: z.string().min(1).max(MAX_PASSWORD_LENGTH), mode }).strict();
export const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH), newPassword: password }).strict();
export const DeleteAccountSchema = z.object({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH) }).strict();

export const publicUser = (u: { id: string; displayName: string; email: string | null }) => ({ id: u.id, displayName: u.displayName, email: u.email });

export async function registerUser(ctx: AppContext, input: z.infer<typeof RegisterSchema>) {
  if (!ctx.config.AUTH_ALLOW_REGISTRATION) throw new AppError("REGISTRATION_CLOSED", "Registration is closed on this deployment.", 403);
  const problems = passwordProblems(input.password, { email: input.email, displayName: input.displayName });
  if (problems.length) throw new AppError("WEAK_PASSWORD", problems.join(" "), 400, { problems });
  const exists = await ctx.db.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (exists) throw new AppError("EMAIL_TAKEN", "An account with this email already exists.", 409);
  const passwordHash = await hashPassword(input.password, ctx.config.AUTH_SCRYPT_LOG2N);
  try {
    return await ctx.db.user.create({
      data: { id: `u_${randomBytes(8).toString("hex")}`, displayName: input.displayName, isSynthetic: false, email: input.email, passwordHash },
      select: { id: true, displayName: true, email: true },
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError("EMAIL_TAKEN", "An account with this email already exists.", 409); // race with a concurrent registration
    throw err;
  }
}

let dummyHash: Promise<string> | null = null;

const dummy = (log2N: number) => (dummyHash ??= hashPassword("not-a-real-password-for-timing", log2N));

export async function checkCredentials(ctx: AppContext, rawEmail: string, pw: string): Promise<{ id: string; displayName: string; email: string | null } | null> {
  const u = await ctx.db.user.findUnique({ where: { email: normalizeEmail(rawEmail) }, select: { id: true, displayName: true, email: true, passwordHash: true, isActive: true } });
  if (!u || !u.passwordHash || !u.isActive) {
    await verifyPassword(pw, await dummy(ctx.config.AUTH_SCRYPT_LOG2N));
    return null;
  }
  if (!(await verifyPassword(pw, u.passwordHash))) return null;
  const data: { lastLoginAt: Date; passwordHash?: string } = { lastLoginAt: new Date() };
  if (needsRehash(u.passwordHash, ctx.config.AUTH_SCRYPT_LOG2N)) data.passwordHash = await hashPassword(pw, ctx.config.AUTH_SCRYPT_LOG2N);
  await ctx.db.user.update({ where: { id: u.id }, data });
  return { id: u.id, displayName: u.displayName, email: u.email };
}

export async function changePassword(ctx: AppContext, userId: string, current: string, next: string): Promise<void> {
  const u = await ctx.db.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true, passwordHash: true } });
  if (!u?.passwordHash || !(await verifyPassword(current, u.passwordHash))) throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);
  const problems = passwordProblems(next, { email: u.email ?? undefined, displayName: u.displayName });
  if (problems.length) throw new AppError("WEAK_PASSWORD", problems.join(" "), 400, { problems });
  await ctx.db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next, ctx.config.AUTH_SCRYPT_LOG2N) } });
}

export async function deleteAccount(ctx: AppContext, userId: string, pw: string): Promise<void> {
  const u = await ctx.db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!u?.passwordHash || !(await verifyPassword(pw, u.passwordHash))) throw new AppError("INVALID_CREDENTIALS", "Password is incorrect.", 401);
  await ctx.db.user.delete({ where: { id: userId } }); // cascades: sessions, relationships, opinions (+aspects, embeddings), search runs
}
