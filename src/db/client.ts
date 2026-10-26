import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

export function createPrisma(connectionString: string): Db {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export { Prisma } from "../generated/prisma/client.js";
