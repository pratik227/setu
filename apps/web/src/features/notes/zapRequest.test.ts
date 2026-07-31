import { describe, expect, it } from "vitest";
import { buildZapRequest } from "./zapRequest";

const RECIPIENT = "a".repeat(64);
const NOTE_ID = "b".repeat(64);

const tagNamed = (
  tags: readonly (readonly string[])[] | undefined,
  name: string,
) => (tags ?? []).find((tag) => tag[0] === name);

describe("buildZapRequest", () => {
  it("emits kind 9734 with the recipient, amount and receipt relays", () => {
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 21_000,
      relays: ["wss://a.example", "wss://b.example"],
    });
    expect(template.kind).toBe(9734);
    expect(tagNamed(template.tags, "p")).toEqual(["p", RECIPIENT]);
    expect(tagNamed(template.tags, "amount")).toEqual(["amount", "21000"]);
    expect(tagNamed(template.tags, "relays")).toEqual([
      "relays",
      "wss://a.example",
      "wss://b.example",
    ]);
  });

  it("tags the note when zapping a note", () => {
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 1000,
      relays: [],
      noteId: NOTE_ID,
    });
    expect(tagNamed(template.tags, "e")).toEqual(["e", NOTE_ID]);
  });

  it("omits the e tag for a zap straight to a profile", () => {
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 1000,
      relays: [],
    });
    expect(tagNamed(template.tags, "e")).toBeUndefined();
  });

  it("echoes an lnurl back when the profile carried a lud06", () => {
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 1000,
      relays: [],
      lnurl: "lnurl1abc",
    });
    expect(tagNamed(template.tags, "lnurl")).toEqual(["lnurl", "lnurl1abc"]);
  });

  it("omits the lnurl tag entirely for a lud16 profile", () => {
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 1000,
      relays: [],
    });
    expect(tagNamed(template.tags, "lnurl")).toBeUndefined();
  });

  it("dedupes and caps the receipt relay list", () => {
    const relays = Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`);
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 1000,
      relays: [...relays, ...relays],
    });
    expect(tagNamed(template.tags, "relays")?.length).toBe(9);
  });

  it("carries a trimmed comment as the content", () => {
    expect(
      buildZapRequest({
        recipient: RECIPIENT,
        amountMsat: 1000,
        relays: [],
        comment: "  thanks  ",
      }).content,
    ).toBe("thanks");
    expect(
      buildZapRequest({ recipient: RECIPIENT, amountMsat: 1000, relays: [] })
        .content,
    ).toBe("");
  });

  it("writes a whole number of millisatoshis", () => {
    const template = buildZapRequest({
      recipient: RECIPIENT,
      amountMsat: 1000.7,
      relays: [],
    });
    expect(tagNamed(template.tags, "amount")).toEqual(["amount", "1000"]);
  });
});
