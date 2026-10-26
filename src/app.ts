import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { AppContext } from "./context.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerRoutes } from "./routes/index.js";
import { registerSecurity } from "./routes/security.js";
import { AppError } from "./shared/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and from dist/src/ (compiled): use the first ../public that exists.
const publicDir = [join(here, "..", "public"), join(here, "..", "..", "public")].find((p) => existsSync(join(p, "index.html"))) ?? join(here, "..", "public");

export async function buildApp(ctx: AppContext, opts: { logger?: boolean; serveUi?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024, requestTimeout: 60_000, trustProxy: ctx.config.TRUST_PROXY });
  registerSecurity(app, ctx);

  // JSON bodies: an empty body is treated as {} (so action endpoints like /accept can be POSTed without a payload);
  // malformed JSON is still a 400. The 16 KB bodyLimit above applies.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try { done(null, JSON.parse(text)); } catch { done(new AppError("INVALID_JSON", "Request body is not valid JSON.", 400)); }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
    }
    if (err instanceof AppError) {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (err.statusCode === 429 && retry) reply.header("Retry-After", String(retry));
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.status(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 16 KB" } });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal server error" } }); // no internals leaked
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found" } }));

  await registerAccountRoutes(app, ctx);
  await registerRoutes(app, ctx);
  if (opts.serveUi !== false) await app.register(fastifyStatic, { root: publicDir, prefix: "/" });
  return app;
}
