import "dotenv/config";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = z.preprocess(emptyToUndefined, z.string().optional());
const optInt = z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional());
const boolStr = z.preprocess(
  (v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : v),
  z.boolean(),
);

const RelType = z.enum(["FRIEND", "FAMILY", "COLLEAGUE", "ACQUAINTANCE"]);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (see .env.example)"),
  ENABLE_DEV_ENDPOINTS: boolStr.default(false),

  INNER_CIRCLE_TYPES: z
    .string()
    .default("FRIEND,FAMILY")
    .transform((s) => s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(RelType).min(1, "INNER_CIRCLE_TYPES must list at least one relationship type")),
  INNER_CIRCLE_MIN_CLOSENESS: z.coerce.number().int().min(1).max(5).default(4),

  EMBEDDING_PROVIDER: z.enum(["none", "openai", "local-glove", "test-hash"]).default("none"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  EMBEDDING_API_KEY: optStr,
  EMBEDDING_DIMENSIONS: optInt,
  GLOVE_MODEL_PATH: z.string().default("data/models/glove-wiki-gigaword-100.sos.bin"),
  ALLOW_TEST_EMBEDDINGS: boolStr.default(false),

  LLM_PROVIDER: z.enum(["none", "anthropic", "openai"]).default("none"),
  LLM_MODEL: z.string().default("openai/gpt-oss-120b"),
  LLM_API_KEY: optStr,
  LLM_BASE_URL: optStr,
  LLM_QUERY_UNDERSTANDING: boolStr.default(true),

  WEB_SEARCH_PROVIDER: z.enum(["none", "brave", "tavily"]).default("none"),
  WEB_SEARCH_API_KEY: optStr,
  WEB_SEARCH_BASE_URL: optStr,

  // ---------- authentication ----------
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  AUTH_ALLOW_REGISTRATION: boolStr.default(true),
  /** log2 of the scrypt cost N. 15 (=32 MiB, ~70 ms) is the default; tests lower it for speed. */
  AUTH_SCRYPT_LOG2N: z.coerce.number().int().min(10).max(18).default(15),
  /** Defaults to true when NODE_ENV=production. */
  AUTH_COOKIE_SECURE: z.preprocess(emptyToUndefined, boolStr.optional()),
  /** Set true when running behind a reverse proxy / platform router (Render, Fly, Caddy...) so req.ip and X-Forwarded-* are trusted. */
  TRUST_PROXY: boolStr.default(false),
  /** Optional canonical origin (e.g. https://app.example.com) used by the CSRF origin check. */
  PUBLIC_ORIGIN: optStr,
  RATE_LIMIT_ENABLED: boolStr.default(true),
  RATE_LIMIT_SEARCH_PER_MIN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().min(1).default(30),

  // ---------- demo accounts + datasets ----------
  /** Seeding creates sign-in accounts for the three demo requesters only if this is true. */
  SEED_DEMO_LOGINS: boolStr.default(true),
  /** Password for the demo accounts. If empty and SEED_DEMO_LOGINS=true, a random one is generated and printed once. */
  DEMO_PASSWORD: optStr,
  /** Allow opinions from data sources flagged public_display_allowed=false to be shown. Ignored (treated as false) in production unless set explicitly. */
  DATASET_ALLOW_RESTRICTED: z.preprocess(emptyToUndefined, boolStr.optional()),

  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(500).max(120000).default(15000),
  REFERENCE_DATE: optStr,
});

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** Validates the environment and fails fast with actionable messages. Never falls back silently. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join(".") || "env"}: ${issue.message}`);
    throw new ConfigError(problems);
  }
  const c = parsed.data;
  if (c.EMBEDDING_PROVIDER === "openai" && !c.EMBEDDING_API_KEY)
    problems.push("EMBEDDING_PROVIDER=openai requires EMBEDDING_API_KEY (or set EMBEDDING_PROVIDER=none)");
  if (c.EMBEDDING_PROVIDER === "test-hash" && c.NODE_ENV === "production")
    problems.push("EMBEDDING_PROVIDER=test-hash is a test-only provider and cannot be used in production");
  if (c.EMBEDDING_PROVIDER === "test-hash" && c.NODE_ENV === "development" && !c.ALLOW_TEST_EMBEDDINGS)
    problems.push("EMBEDDING_PROVIDER=test-hash is test-only; set ALLOW_TEST_EMBEDDINGS=true to use it deliberately");
  if (c.LLM_PROVIDER !== "none" && !c.LLM_API_KEY)
    problems.push(`LLM_PROVIDER=${c.LLM_PROVIDER} requires LLM_API_KEY (or set LLM_PROVIDER=none)`);
  if (c.WEB_SEARCH_PROVIDER !== "none" && !c.WEB_SEARCH_API_KEY)
    problems.push(`WEB_SEARCH_PROVIDER=${c.WEB_SEARCH_PROVIDER} requires WEB_SEARCH_API_KEY (or set WEB_SEARCH_PROVIDER=none)`);
  if (c.REFERENCE_DATE && Number.isNaN(Date.parse(c.REFERENCE_DATE)))
    problems.push("REFERENCE_DATE must be an ISO date such as 2026-10-20");
  if (problems.length) throw new ConfigError(problems);
  return c;
}

export const cookieSecure = (c: Pick<AppConfig, "AUTH_COOKIE_SECURE" | "NODE_ENV">): boolean => c.AUTH_COOKIE_SECURE ?? c.NODE_ENV === "production";
/** Restricted (non-displayable) data sources are hidden unless explicitly allowed; in production the default is hidden. */
export const allowRestrictedData = (c: Pick<AppConfig, "DATASET_ALLOW_RESTRICTED" | "NODE_ENV">): boolean => c.DATASET_ALLOW_RESTRICTED ?? c.NODE_ENV !== "production";

export function referenceNow(cfg: Pick<AppConfig, "REFERENCE_DATE">): Date {
  return cfg.REFERENCE_DATE ? new Date(cfg.REFERENCE_DATE) : new Date();
}
