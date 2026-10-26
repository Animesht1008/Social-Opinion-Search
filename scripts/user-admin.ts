/**
 * Minimal operator tool (there is no email-based password reset, so this is the recovery path):
 *   npm run user:admin -- create <email> "<Display Name>"     (prompts for nothing; password via env USER_PASSWORD)
 *   npm run user:admin -- set-password <email>                (new password via env USER_PASSWORD; revokes all sessions)
 *   npm run user:admin -- disable <email> | enable <email>    (disable also revokes sessions)
 *   npm run user:admin -- list
 * The password is read from the USER_PASSWORD environment variable so it never appears in shell history arguments.
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/env.js";
import { createPrisma } from "../src/db/client.js";
import { hashPassword, passwordProblems } from "../src/modules/auth/password.js";
import { normalizeEmail } from "../src/modules/auth/service.js";

const [cmd, emailArg, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const db = createPrisma(cfg.DATABASE_URL);
const fail = (m: string): never => { console.error(m); process.exit(1); };
try {
  if (cmd === "list") {
    for (const u of await db.user.findMany({ where: { email: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, displayName: true, isActive: true, lastLoginAt: true } })) console.log(`${u.id}  ${u.email}  ${u.isActive ? "active" : "DISABLED"}  ${u.displayName}  last login: ${u.lastLoginAt?.toISOString() ?? "never"}`);
  } else if (!emailArg) {
    fail("Usage: user:admin -- <create|set-password|disable|enable|list> <email> [display name]");
  } else {
    const email = normalizeEmail(emailArg);
    if (cmd === "create" || cmd === "set-password") {
      const pw = process.env.USER_PASSWORD ?? fail("Set USER_PASSWORD in the environment (not on the command line).");
      const problems = passwordProblems(pw, { email });
      if (problems.length) fail(problems.join(" "));
      const passwordHash = await hashPassword(pw, cfg.AUTH_SCRYPT_LOG2N);
      if (cmd === "create") {
        const name = rest.join(" ").trim() || email.split("@")[0]!;
        const u = await db.user.create({ data: { id: `u_${randomBytes(8).toString("hex")}`, displayName: name, isSynthetic: false, email, passwordHash } });
        console.log(`Created ${u.id} (${email}).`);
      } else {
        const u = await db.user.update({ where: { email }, data: { passwordHash } });
        console.log(`Password updated for ${u.id}; ${(await db.session.deleteMany({ where: { userId: u.id } })).count} session(s) revoked.`);
      }
    } else if (cmd === "disable" || cmd === "enable") {
      const u = await db.user.update({ where: { email }, data: { isActive: cmd === "enable" } });
      if (cmd === "disable") await db.session.deleteMany({ where: { userId: u.id } });
      console.log(`${cmd}d ${u.id}.`);
    } else fail(`Unknown command ${cmd}`);
  }
} finally {
  await db.$disconnect();
}
