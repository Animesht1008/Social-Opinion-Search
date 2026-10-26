import { describe, expect, it } from "vitest";
import { IntentSchema, deriveFilters, FiltersSchema } from "../../src/modules/query-understanding/intent.js";
import { applyApiFilters, mergeLlmIntent, parseQueryRules, understandQuery, type ParseContext } from "../../src/modules/query-understanding/parser.js";
import type { LlmProvider } from "../../src/modules/llm/provider.js";

const ctx: ParseContext = {
  cities: ["Bengaluru", "Delhi", "Goa", "Jaipur", "Mumbai"],
  neighborhoods: { Mumbai: ["Bandra", "Colaba", "Juhu"], Delhi: ["Paharganj"], Bengaluru: ["Indiranagar"] },
  now: new Date("2026-10-20T00:00:00Z"),
};

describe("rule-based query understanding", () => {
  it("parses the headline query into a validated structured intent", () => {
    const i = parseQueryRules("I'm visiting Mumbai with my sister. Find a hotel area suitable for returning late at night; consider lighting, isolation and transport.", ctx);
    expect(() => IntentSchema.parse(i)).not.toThrow();
    expect(i.parser).toBe("rule-v1");
    expect(i.location.city).toBe("Mumbai");
    expect(i.topic).toBe("hotel_area");
    expect(i.aspects).toEqual(expect.arrayContaining(["lighting", "activity_isolation", "transport", "late_night"]));
    expect(i.hardConstraints.find((c) => c.kind === "city")).toMatchObject({ value: "Mumbai", verifiable: true });
    expect(i.softPreferences).toContain("travelling with sister");
    expect(i.keywords).not.toContain("mumbai");
    expect(i.keywords).not.toContain("sister");
    expect(i.evidenceCharacteristics).toEqual(expect.arrayContaining(["include_negative", "include_conflicting"]));
  });
  it("recognizes plural hotel queries without inventing unspecified aspects", () => {
    const i = parseQueryRules("Hotels in Mumbai?", ctx);
    expect(i.topic).toBe("hotel_area");
    expect(i.aspects).toEqual([]);
    expect(i.ambiguities.join(" ")).toMatch(/No known aspect/);
  });
  it("extracts explicit hard constraints: firsthand, time window, inner circle", () => {
    const i = parseQueryRules("Only from my close friends, people who actually stayed in Mumbai in the last 6 months", ctx);
    const kinds = i.hardConstraints.map((c) => c.kind).sort();
    expect(kinds).toEqual(["channel", "city", "firsthand_only", "since"]);
    expect(i.hardConstraints.find((c) => c.kind === "since")?.value).toBe("2026-04-20");
    expect(deriveFilters(i)).toMatchObject({ city: "Mumbai", firsthandOnly: true, since: "2026-04-20", channels: ["inner_circle"] });
  });
  it("marks unverifiable must-haves instead of pretending to filter on them", () => {
    const i = parseQueryRules("Mumbai hotel that must have a swimming pool", ctx);
    const c = i.hardConstraints.find((x) => x.kind === "unverifiable")!;
    expect(c.verifiable).toBe(false);
    expect(deriveFilters(i)).toEqual({ city: "Mumbai" });
  });
  it("turns an unknown city into an enforced filter (so results are empty, not from another city)", () => {
    const i = parseQueryRules("I'm visiting Lisbon alone, which hotel area is safe at night?", ctx);
    expect(deriveFilters(i).city).toBe("Lisbon");
    expect(i.ambiguities.join(" ")).toMatch(/not present in the corpus/);
  });
  it("infers the city from a known neighborhood and aliases", () => {
    expect(deriveFilters(parseQueryRules("Is Paharganj noisy at night?", ctx)).city).toBe("Delhi");
    expect(deriveFilters(parseQueryRules("quiet cafe in Bangalore", { ...ctx, cities: [...ctx.cities] })).city).toBe("Bengaluru");
  });
  it("reports ambiguity instead of inventing structure", () => {
    const i = parseQueryRules("dark streets", ctx);
    expect(i.location.city).toBeNull();
    expect(i.ambiguities.join(" ")).toMatch(/No location detected/);
  });
  it("API filters become explicit hard constraints and override parsed ones", () => {
    const base = parseQueryRules("quiet beach in Goa", ctx);
    const i = applyApiFilters(base, { city: "Mumbai", firsthandOnly: true, channels: ["inner_circle"] });
    expect(deriveFilters(i)).toMatchObject({ city: "Mumbai", firsthandOnly: true, channels: ["inner_circle"] });
    expect(i.hardConstraints.filter((c) => c.kind === "city")).toHaveLength(1);
    expect(i.hardConstraints.find((c) => c.kind === "city")?.source).toBe("api");
  });
  it("rejects malformed filters", () => {
    expect(FiltersSchema.safeParse({ since: "yesterday" }).success).toBe(false);
    expect(FiltersSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });
});

describe("LLM-assisted parsing is validated and grounded", () => {
  const rule = parseQueryRules("quiet cafe to work from in Mumbai", ctx);
  it("drops an LLM city that is not in the query and demotes unknown aspects to soft preferences", () => {
    const out = mergeLlmIntent(parseQueryRules("quiet cafe to work from", ctx), { city: "Goa", aspects: ["noise", "made_up_aspect"], firsthandOnly: true }, ctx, "test-llm");
    expect(out.parser).toContain("llm:test-llm");
    expect(out.location.city).toBeNull();
    expect(out.warnings.join(" ")).toMatch(/Goa/);
    expect(out.aspects).toContain("noise");
    expect(out.aspects).not.toContain("made_up_aspect");
    expect(out.softPreferences).toContain("made_up_aspect");
    expect(out.hardConstraints.some((c) => c.kind === "firsthand_only")).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/firsthand-only/);
  });
  it("keeps grounded LLM constraints", () => {
    const out = mergeLlmIntent(rule, { city: "Mumbai", unverifiableConstraints: ["has parking"] }, ctx, "t");
    expect(out.hardConstraints.find((c) => c.text === "has parking")?.verifiable).toBe(false);
  });
  it("rejects structurally invalid LLM output", () => {
    expect(() => mergeLlmIntent(rule, { topic: "spaceship" }, ctx, "t")).toThrow();
  });
  it("falls back to rules (and says so) when the LLM fails", async () => {
    const llm: LlmProvider = { id: "x:y", kind: "openai", model: "y", generateJson: async () => { throw new Error("boom"); } };
    const i = await understandQuery({ query: "quiet cafe in Mumbai", ctx, llm, useLlm: true, timeoutMs: 100 });
    expect(i.parser).toBe("rule-v1");
    expect(i.warnings.join(" ")).toMatch(/LLM query understanding failed \(boom\)/);
  });
  it("does not call the LLM when none is configured", async () => {
    const i = await understandQuery({ query: "quiet cafe in Mumbai", ctx, llm: null, useLlm: true, timeoutMs: 100 });
    expect(i.parser).toBe("rule-v1");
    expect(i.warnings).toEqual([]);
  });
});
