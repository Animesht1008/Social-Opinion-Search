import "dotenv/config";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/env.js";
import { createPrisma } from "../src/db/client.js";
import { seedDatabase } from "../src/db/seed.js";

const cfg = loadConfig();
const db = createPrisma(cfg.DATABASE_URL);
try {
  let password = cfg.DEMO_PASSWORD;
  let generated = false;
  if (cfg.SEED_DEMO_LOGINS && !password) {
    password = randomBytes(9).toString("base64url");
    generated = true;
  }
  const s = await seedDatabase(db, "data", { demoLogins: cfg.SEED_DEMO_LOGINS && password ? { password, log2N: cfg.AUTH_SCRYPT_LOG2N } : null });
  const { demoLogins, ...counts } = s;
  console.log("Seeded synthetic demo data:", counts);
  if (demoLogins.length) {
    console.log("\nDemo sign-in accounts (synthetic users):\n  " + demoLogins.join("\n  "));
    console.log(generated ? `  password (generated, shown once): ${password}` : "  password: the value of DEMO_PASSWORD in your environment");
    console.log("  Set SEED_DEMO_LOGINS=false to seed without any sign-in accounts (recommended for public deployments).");
  } else {
    console.log("No demo sign-in accounts were created (SEED_DEMO_LOGINS=false). Register through the UI or API instead.");
  }
  console.log("\nNext: `npm run embeddings:index` (if an embedding provider is configured).");
} finally {
  await db.$disconnect();
}
