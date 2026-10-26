import { describe, expect, it } from "vitest";
import { canonicalCity, dedupeKey, looksEnglish, normalizeRating, normalizeText, parseDate, scrubPii } from "../../src/modules/datasets/clean.js";
import { AdapterError, parseMap, pick } from "../../src/modules/datasets/adapters.js";
import { REGISTRY, SourceMetaSchema } from "../../src/modules/datasets/registry.js";

describe("normalizeText", () => {
  it("strips tags and decodes common entities, collapses whitespace", () => {
    expect(normalizeText("Great &amp; clean!<br/>Really   nice<p>place</p>\n\nwith &quot;style&quot;&nbsp;too")).toBe('Great & clean! Really nice place with "style" too');
  });
  it("removes control characters", () => {
    expect(normalizeText("a\u0000b\u0007c")).toBe("a b c");
  });
});

describe("scrubPii", () => {
  it("masks emails, links, phone-like numbers and handles, and counts them", () => {
    const r = scrubPii("Mail me at jo@example.com or call +44 20 7946 0958 / 0123456789, see https://x.test/a?b=1 and www.example.com, follow @foodie_blog");
    expect(r.text).not.toMatch(/jo@example|7946|0123456789|x\.test|www\.|@foodie/);
    expect(r.text).toContain("[email]");
    expect(r.masked).toEqual({ emails: 1, urls: 2, phones: 2, handles: 1 });
  });
  it("keeps dates, prices, ratings and short numbers", () => {
    const t = "We went on 2019-05-20 and paid 450 rupees for 4 people at 12:30, rated 4.5/5 in room 1204";
    expect(scrubPii(t).text).toBe(t);
  });
});

describe("looksEnglish", () => {
  it("accepts English and rejects other languages / noise", () => {
    expect(looksEnglish("The food was delicious and the staff were very friendly to us.")).toBe(true);
    expect(looksEnglish("La comida estaba muy buena y el servicio fue excelente, volveremos pronto.")).toBe(false);
    expect(looksEnglish("料理はとても美味しくて、スタッフも親切でした。また来ます。")).toBe(false);
    expect(looksEnglish("ok")).toBe(false);
    expect(looksEnglish("")).toBe(false);
  });
});

describe("canonicalCity, parseDate, normalizeRating, dedupeKey", () => {
  it("canonicalises city spellings", () => {
    expect(canonicalCity("New_Delhi")).toBe("Delhi");
    expect(canonicalCity(" bangalore ")).toBe("Bengaluru");
    expect(canonicalCity("new-york")).toBe("New York");
    expect(canonicalCity("LONDON")).toBe("London");
    expect(canonicalCity("   ")).toBe("");
  });
  it("parses the common date layouts and rejects nonsense", () => {
    const d = (s: string) => parseDate(s)?.toISOString().slice(0, 10) ?? null;
    expect(d("2019-05-20")).toBe("2019-05-20");
    expect(d("2019-05-20T10:00:00Z")).toBe("2019-05-20");
    expect(d("March 5, 2019")).toBe("2019-03-05");
    expect(d("27 February 2018")).toBe("2018-02-27");
    expect(d("12/08/2018")).toBe("2018-08-12"); // day-first
    expect(d("May 2020")).toBe("2020-05-01");
    expect(d("1589500800")).toBe("2020-05-15");
    expect(d("yesterday")).toBeNull();
    expect(d("2019-02-31")).toBeNull();
    expect(d("")).toBeNull();
  });
  it("normalises ratings from 1-5, 10-50 and 0-10 scales", () => {
    expect(normalizeRating("4")).toBe(4);
    expect(normalizeRating("50")).toBe(5);
    expect(normalizeRating("30")).toBe(3);
    expect(normalizeRating("8")).toBe(4);
    expect(normalizeRating("4,5")).toBe(5);
    expect(normalizeRating("")).toBeNull();
    expect(normalizeRating("abc")).toBeNull();
    expect(normalizeRating("0")).toBeNull();
    expect(normalizeRating("999")).toBeNull();
  });
  it("dedupe key ignores case, punctuation and spacing", () => {
    expect(dedupeKey("Great food!  Really, great.")).toBe(dedupeKey("great food really great"));
    expect(dedupeKey("a b")).not.toBe(dedupeKey("a c"));
  });
});

describe("adapter helpers and registry", () => {
  it("finds columns case/punctuation-insensitively and reports detected headers when missing", () => {
    expect(pick(["Review_Full", "DATE"], ["review_full"])).toBe("Review_Full");
    expect(pick(["a"], ["b"])).toBeUndefined();
    expect(parseMap("text=Review,category=const:restaurant")).toEqual({ text: "Review", category: "const:restaurant" });
    expect(() => parseMap("oops")).toThrow(AdapterError);
  });
  it("every registry entry validates and states licence, attribution and display policy", () => {
    for (const s of REGISTRY) {
      expect(() => SourceMetaSchema.parse(s)).not.toThrow();
      expect(s.terms.length).toBeGreaterThan(0);
    }
    const airbnb = REGISTRY.find((s) => s.id === "inside-airbnb")!;
    expect(airbnb.publicDisplayAllowed).toBe(false); // "do not republish" => never displayable by default
    expect(REGISTRY.find((s) => s.id === "tripadvisor-dyadic-2022")!.commercialUseAllowed).toBe(false);
  });
});
