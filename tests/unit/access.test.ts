import { describe, expect, it } from "vitest";
import { buildAccessContext, canViewOpinion, channelOf, isInnerCircle } from "../../src/modules/social-access/access.js";

const rule = { types: ["FRIEND", "FAMILY"], minCloseness: 4 };
const rels = [
  { requesterId: "me", addresseeId: "sis", status: "ACCEPTED", type: "FAMILY", closeness: 5 },
  { requesterId: "bff", addresseeId: "me", status: "ACCEPTED", type: "FRIEND", closeness: 4 }, // addressee direction
  { requesterId: "me", addresseeId: "casual", status: "ACCEPTED", type: "FRIEND", closeness: 2 },
  { requesterId: "me", addresseeId: "boss", status: "ACCEPTED", type: "COLLEAGUE", closeness: 5 },
  { requesterId: "me", addresseeId: "pending", status: "PENDING", type: "FRIEND", closeness: 5 },
  { requesterId: "stalker", addresseeId: "me", status: "BLOCKED", type: "FRIEND", closeness: 5 },
];
const ctx = buildAccessContext("me", rels, rule);

describe("inner circle definition", () => {
  it("is configurable and requires ACCEPTED + type + closeness", () => {
    expect(isInnerCircle({ status: "ACCEPTED", type: "FRIEND", closeness: 4 }, rule)).toBe(true);
    expect(isInnerCircle({ status: "ACCEPTED", type: "FRIEND", closeness: 3 }, rule)).toBe(false);
    expect(isInnerCircle({ status: "ACCEPTED", type: "COLLEAGUE", closeness: 5 }, rule)).toBe(false);
    expect(isInnerCircle({ status: "PENDING", type: "FAMILY", closeness: 5 }, rule)).toBe(false);
    expect(isInnerCircle({ status: "ACCEPTED", type: "COLLEAGUE", closeness: 5 }, { types: ["COLLEAGUE"], minCloseness: 5 })).toBe(true);
  });
  it("does not treat every accepted connection as inner circle", () => {
    expect(ctx.connectionIds).toEqual(["bff", "boss", "casual", "sis"]);
    expect(ctx.innerCircleIds).toEqual(["bff", "sis"]);
  });
  it("grants nothing for pending or blocked relationships", () => {
    expect(ctx.connectionIds).not.toContain("pending");
    expect(ctx.blockedIds).toEqual(["stalker"]);
  });
});

describe("opinion visibility", () => {
  const view = (authorId: string, visibility: any) => canViewOpinion(ctx, { authorId, visibility });
  it("PUBLIC is visible to anyone except self and blocked users", () => {
    expect(view("stranger", "PUBLIC")).toBe(true);
    expect(view("pending", "PUBLIC")).toBe(true);
    expect(view("stalker", "PUBLIC")).toBe(false);
    expect(view("me", "PUBLIC")).toBe(false);
  });
  it("CONNECTIONS needs an accepted relationship", () => {
    expect(view("casual", "CONNECTIONS")).toBe(true);
    expect(view("boss", "CONNECTIONS")).toBe(true);
    expect(view("pending", "CONNECTIONS")).toBe(false);
    expect(view("stranger", "CONNECTIONS")).toBe(false);
  });
  it("INNER_CIRCLE needs the configured inner circle", () => {
    expect(view("sis", "INNER_CIRCLE")).toBe(true);
    expect(view("casual", "INNER_CIRCLE")).toBe(false);
    expect(view("boss", "INNER_CIRCLE")).toBe(false);
    expect(view("pending", "INNER_CIRCLE")).toBe(false);
  });
  it("PRIVATE is never visible to others", () => {
    for (const a of ["sis", "casual", "stranger", "pending"]) expect(view(a, "PRIVATE")).toBe(false);
  });
  it("labels channels", () => {
    expect(channelOf(ctx, "sis")).toBe("inner_circle");
    expect(channelOf(ctx, "casual")).toBe("wider_social");
    expect(channelOf(ctx, "stranger")).toBe("wider_social");
  });
});
