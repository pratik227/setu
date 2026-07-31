import { decodeAny, stripNostrScheme } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { copyMessage, copyText, noteReference } from "./noteLink";

const NOTE_ID = "a".repeat(64);
const AUTHOR = "b".repeat(64);

describe("noteReference", () => {
  it("carries the author and a relay hint so the link resolves elsewhere", () => {
    const reference = noteReference({
      id: NOTE_ID,
      author: AUTHOR,
      kind: 1,
      relayHint: "wss://relay.example.com",
    });
    expect(reference).toBeDefined();
    expect(reference?.startsWith("nostr:nevent1")).toBe(true);

    const decoded = decodeAny(stripNostrScheme(reference as string));
    expect(decoded?.type).toBe("nevent");
    if (decoded?.type !== "nevent") return;
    expect(decoded.id).toBe(NOTE_ID);
    expect(decoded.author).toBe(AUTHOR);
    expect(decoded.kind).toBe(1);
    expect(decoded.relays).toContain("wss://relay.example.com");
  });

  it("encodes an id-only reference when nothing else is known", () => {
    const reference = noteReference({ id: NOTE_ID });
    const decoded = decodeAny(stripNostrScheme(reference as string));
    expect(decoded?.type).toBe("nevent");
    if (decoded?.type !== "nevent") return;
    expect(decoded.id).toBe(NOTE_ID);
    expect(decoded.author).toBeUndefined();
  });

  it("declines rather than emitting a reference that cannot be decoded", () => {
    expect(noteReference({ id: "not-an-id" })).toBeUndefined();
    expect(noteReference({ id: "" })).toBeUndefined();
  });
});

describe("copyText", () => {
  const original = globalThis.navigator;

  function withClipboard(clipboard: unknown) {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard },
      configurable: true,
      writable: true,
    });
  }

  function restore() {
    Object.defineProperty(globalThis, "navigator", {
      value: original,
      configurable: true,
      writable: true,
    });
  }

  it("reports success when the clipboard accepts the write", async () => {
    const written: string[] = [];
    withClipboard({
      writeText: async (text: string) => {
        written.push(text);
      },
    });
    try {
      expect(await copyText("nostr:nevent1x")).toEqual({ ok: true });
      expect(written).toEqual(["nostr:nevent1x"]);
    } finally {
      restore();
    }
  });

  it("hands the text back when there is no Clipboard API", async () => {
    withClipboard(undefined);
    try {
      const result = await copyText("nostr:nevent1x");
      expect(result).toEqual({
        ok: false,
        reason: "unsupported",
        text: "nostr:nevent1x",
      });
      expect(copyMessage(result)).toContain("copy it manually");
    } finally {
      restore();
    }
  });

  it("hands the text back when the write is refused", async () => {
    withClipboard({
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    });
    try {
      const result = await copyText("nostr:nevent1x");
      expect(result).toEqual({
        ok: false,
        reason: "denied",
        text: "nostr:nevent1x",
      });
    } finally {
      restore();
    }
  });
});
