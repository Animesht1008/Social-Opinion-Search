import { z } from "zod";

export const SourceMetaSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/, "id: lowercase letters, digits, dashes"),
  shortCode: z.string().regex(/^[a-z0-9]{3,10}$/),
  name: z.string().min(3).max(160),
  description: z.string().max(800).optional(),
  url: z.string().url(),
  license: z.string().min(2).max(200),
  licenseId: z.string().min(2).max(60),
  licenseUrl: z.string().url().optional(),
  attribution: z.string().min(3).max(400),
  commercialUseAllowed: z.boolean(),
  publicDisplayAllowed: z.boolean(),
  assumeFirsthand: z.boolean().default(true),
  adapter: z.enum(["tripadvisor-dyadic", "inside-airbnb", "generic-csv"]),
  geography: z.string().max(300).optional(),
  limitations: z.string().max(1500),
  terms: z.array(z.string()).default([]),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

export const REGISTRY: SourceMeta[] = [
  {
    id: "tripadvisor-dyadic-2022",
    shortCode: "tadyad",
    name: "TripAdvisor Dataset for Dyadic Context Analysis (restaurant reviews)",
    description: "English-language TripAdvisor restaurant reviews published for research, distributed as one CSV per city.",
    url: "https://zenodo.org/record/6583422",
    license: "CC BY-NC 4.0 (non-commercial, attribution required)",
    licenseId: "CC-BY-NC-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/",
    attribution: "\"A TripAdvisor Dataset for Dyadic Context Analysis\", Zenodo record 6583422 (v1.0, 2022). See the record for authors, DOI and the recommended citation.",
    commercialUseAllowed: false,
    publicDisplayAllowed: true,
    assumeFirsthand: true,
    adapter: "tripadvisor-dyadic",
    geography: "Cities as listed in the dataset's city column (per-city files).",
    limitations: "Restaurants only; original TripAdvisor reviews can contain personal names and the importer masks only emails, links, phone-like numbers and @handles. No reviewer ids are used (each review is its own pseudonymous author). English-only by the dataset's construction. Non-commercial licence: do not use in a commercial product.",
    terms: [
      "Licence: Creative Commons Attribution-NonCommercial 4.0 International.",
      "You must give attribution (shown in the UI and API) and may not use the data commercially.",
      "The source reviews were written by TripAdvisor users; the dataset record, not this project, grants the licence.",
    ],
  },
  {
    id: "inside-airbnb",
    shortCode: "airbnb",
    name: "Inside Airbnb — detailed reviews and listings",
    description: "Guest reviews of Airbnb listings with the listing's neighbourhood, from the independent Inside Airbnb project. You download it yourself; this project does not redistribute it.",
    url: "https://insideairbnb.com/get-the-data/",
    license: "Inside Airbnb data policies (attribution required; republishing the data is not permitted)",
    licenseId: "INSIDE-AIRBNB-POLICY",
    licenseUrl: "https://insideairbnb.com/data-policies/",
    attribution: "Data from Inside Airbnb (insideairbnb.com), source: Airbnb public listings.",
    commercialUseAllowed: false,
    publicDisplayAllowed: false,
    assumeFirsthand: true,
    adapter: "inside-airbnb",
    geography: "One city per download; pass --city.",
    limitations: "Guest-written Airbnb stay reviews (not area guides); many are short, positive and multilingual; hosts' first names appear in text. The data policies ask users not to republish the data, so this source is flagged public_display_allowed=false and is hidden from other users in production by default.",
    terms: [
      "The Inside Airbnb data policies (retrieved while building this feature) ask you to attribute and cite the data, not to scrape the site, and not to republish the data.",
      "Therefore this source is imported for PRIVATE analysis only. In production (NODE_ENV=production) it is hidden from search results unless you explicitly set DATASET_ALLOW_RESTRICTED=true after confirming your rights.",
      "Re-check the current policy and the licence stated for your snapshot before use; licence wording has changed between snapshots.",
    ],
  },
];

export const findSource = (id: string): SourceMeta | undefined => REGISTRY.find((s) => s.id === id);
