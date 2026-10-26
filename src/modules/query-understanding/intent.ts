import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const HardConstraintSchema = z.object({
  kind: z.enum(["city", "category", "firsthand_only", "since", "channel", "source_type", "data_source", "unverifiable"]),
  value: z.union([z.string(), z.boolean(), z.array(z.string())]),
  text: z.string(),
  verifiable: z.boolean(),
  source: z.enum(["rule", "llm", "api"]),
});
export type HardConstraint = z.infer<typeof HardConstraintSchema>;

export const IntentSchema = z.object({
  rawQuery: z.string(),
  parser: z.string(),
  topic: z.string().nullable(),
  location: z.object({ city: z.string().nullable(), neighborhood: z.string().nullable() }),
  aspects: z.array(z.string()),
  keywords: z.array(z.string()),
  hardConstraints: z.array(HardConstraintSchema),
  softPreferences: z.array(z.string()),
  temporal: z.object({
    recencyPreference: z.enum(["none", "recent"]),
    since: isoDate.nullable(),
    note: z.string().nullable(),
  }),
  evidenceCharacteristics: z.array(z.enum(["firsthand", "recent", "specific", "include_negative", "include_conflicting"])),
  ambiguities: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type Intent = z.infer<typeof IntentSchema>;

export const LlmIntentSchema = z.object({
  city: z.string().nullable().default(null),
  neighborhood: z.string().nullable().default(null),
  topic: z.enum(["hotel_area", "cafe", "restaurant", "other"]).nullable().default(null),
  aspects: z.array(z.string()).default([]),
  firsthandOnly: z.boolean().default(false),
  sinceDate: isoDate.nullable().default(null),
  onlyInnerCircle: z.boolean().default(false),
  recencyPreference: z.enum(["none", "recent"]).default("none"),
  softPreferences: z.array(z.string()).default([]),
  unverifiableConstraints: z.array(z.string()).default([]),
  ambiguities: z.array(z.string()).default([]),
});
export type LlmIntent = z.infer<typeof LlmIntentSchema>;

export const FiltersSchema = z
  .object({
    city: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    since: isoDate.optional(),
    firsthandOnly: z.boolean().optional(),
    sourceTypes: z.array(z.enum(["SOCIAL_USER", "PUBLIC_REVIEW"])).min(1).optional(),
    channels: z.array(z.enum(["inner_circle", "wider_social"])).min(1).optional(),
    /** Restrict to specific corpora by data-source id (see GET /api/v1/data-sources). */
    dataSources: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
  })
  .strict();
export type ApiFilters = z.infer<typeof FiltersSchema>;

export interface HardFilters {
  city?: string;
  category?: string;
  since?: string;
  firsthandOnly?: boolean;
  sourceTypes?: ("SOCIAL_USER" | "PUBLIC_REVIEW")[];
  channels?: ("inner_circle" | "wider_social")[];
  dataSources?: string[];
}

export function deriveFilters(intent: Intent): HardFilters {
  const f: HardFilters = {};
  for (const c of intent.hardConstraints) {
    if (!c.verifiable) continue;
    if (c.kind === "city" && typeof c.value === "string") f.city = c.value;
    else if (c.kind === "category" && typeof c.value === "string") f.category = c.value;
    else if (c.kind === "since" && typeof c.value === "string") f.since = c.value;
    else if (c.kind === "firsthand_only" && c.value === true) f.firsthandOnly = true;
    else if (c.kind === "source_type" && Array.isArray(c.value)) f.sourceTypes = c.value as HardFilters["sourceTypes"];
    else if (c.kind === "channel" && Array.isArray(c.value)) f.channels = c.value as HardFilters["channels"];
    else if (c.kind === "data_source" && Array.isArray(c.value)) f.dataSources = c.value as string[];
  }
  return f;
}
