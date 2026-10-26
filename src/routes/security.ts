import type { FastifyInstance } from "fastify";
import { cookieSecure } from "../config/env.js";
import type { AppContext } from "../context.js";
import { AppError } from "../shared/errors.js";

/**
 * Defence-in-depth HTTP hardening:
 *  - strict CSP (no inline script/style; the UI is written to comply),
 *  - nosniff / no-referrer / frame-ancestors none,
 *  - HSTS when cookies are Secure,
 *  - Cache-Control: no-store for API responses (they contain personal data),
 *  - CSRF origin check for state-changing, cookie-authenticated requests.
 */
export function registerSecurity(app: FastifyInstance, ctx: AppContext) {
  const secure = cookieSecure(ctx.config);
  app.addHook("onSend", async (req, reply) => {
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (secure) reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    if (req.url.startsWith("/api/") || req.url === "/health") reply.header("Cache-Control", "no-store");
  });

  const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.addHook("onRequest", async (req) => {
    if (!UNSAFE.has(req.method)) return;
    if (typeof req.headers.authorization === "string") return; // bearer tokens are not ambient credentials => no CSRF exposure
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (origin) {
      let o: URL;
      try { o = new URL(origin); } catch { throw new AppError("CSRF_BLOCKED", "Invalid Origin header.", 403); }
      // Normalise every candidate with the Origin's own scheme so default ports compare equal ("localhost:80" == "localhost" for http).
      const norm = (hostPort: string): string | null => { try { return new URL(`${o.protocol}//${hostPort}`).host; } catch { return null; } };
      const allowed = new Set<string>();
      const add = (h: unknown) => { if (typeof h === "string") { const n = norm(h); if (n) allowed.add(n); } };
      add(req.headers.host);
      if (ctx.config.PUBLIC_ORIGIN) add(new URL(ctx.config.PUBLIC_ORIGIN).host);
      if (ctx.config.TRUST_PROXY) add(req.headers["x-forwarded-host"]);
      if (!allowed.has(o.host)) throw new AppError("CSRF_BLOCKED", "Cross-origin request blocked.", 403);
    } else if (site === "cross-site") {
      throw new AppError("CSRF_BLOCKED", "Cross-site request blocked.", 403);
    }
  });
}
