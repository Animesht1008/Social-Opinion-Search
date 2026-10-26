import { readFileSync } from "node:fs";
import type { Db } from "../../db/client.js";

export interface EvalQueryRow {
  id: string;
  query: string;
  requesterId: string;
  tags: string[];
  hardConstraints: { city?: string; firsthandOnly?: boolean; since?: string; channels?: string[] };
  expectedAspects: string[];
  expectInsufficient: boolean;
  split: "dev" | "test";
  grades: Map<string, number>;
}

/** Duplicate groups known from the corpus design (explicit reposts and copied wording). Used only for evaluation. */
export const DUPLICATE_GROUPS: string[][] = [
  ["op_m05", "op_m20"],
  ["op_m01", "op_m21"],
  ["op_b01", "op_b19"],
  ["op_g11", "op_g15"],
  ["op_j01", "op_j15"],
];

export async function loadEvalData(db: Db, dir = "data/eval") {
  const queries = await db.evalQuery.findMany({ include: { judgments: true }, orderBy: { id: "asc" } });
  const fileQueries = JSON.parse(readFileSync(`${dir}/queries.json`, "utf8")) as { id: string; split: "dev" | "test" }[];
  const split = new Map(fileQueries.map((q) => [q.id, q.split]));
  const labels = (JSON.parse(readFileSync(`${dir}/aspect_labels.json`, "utf8")) as { labels: Record<string, string[]> }).labels;
  const rows: EvalQueryRow[] = queries.map((q) => ({
    id: q.id,
    query: q.query,
    requesterId: q.requesterId,
    tags: q.tags,
    hardConstraints: q.hardConstraints as EvalQueryRow["hardConstraints"],
    expectedAspects: q.expectedAspects,
    expectInsufficient: q.expectInsufficient,
    split: split.get(q.id) ?? "test",
    grades: new Map(q.judgments.map((j) => [j.opinionId, j.grade])),
  }));
  return { queries: rows, aspectLabels: labels };
}
