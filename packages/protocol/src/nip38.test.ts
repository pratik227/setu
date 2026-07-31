import { describe, expect, it } from "vitest";
import { currentUserStatus, isStatusExpired, parseUserStatus } from "./nip38";
import type { NostrEvent } from "./types";

const AUTHOR = "a".repeat(64);
const NOW = 1_700_000_000;

let counter = 0;
function status(over: {
  d?: string;
  content?: string;
  tags?: readonly (readonly string[])[];
  createdAt?: number;
  kind?: number;
}): NostrEvent {
  counter += 1;
  const tags: string[][] = over.tags
    ? over.tags.map((t) => [...t])
    : [["d", over.d ?? "general"]];
  return {
    id: String(counter).padStart(64, "0"),
    pubkey: AUTHOR,
    created_at: over.createdAt ?? NOW,
    kind: over.kind ?? 30315,
    tags,
    content: over.content ?? "at the airport",
    sig: "0".repeat(128),
  };
}

describe("parseUserStatus", () => {
  it("reads a general status", () => {
    const parsed = parseUserStatus(status({ content: "shipping" }));
    expect(parsed).toEqual({
      kind: "general",
      content: "shipping",
      createdAt: NOW,
    });
  });

  it("reads a music status", () => {
    expect(parseUserStatus(status({ d: "music" }))?.kind).toBe("music");
  });

  it("rejects a d tag outside the spec rather than defaulting to general", () => {
    // Showing a status written for one context in another puts words in the author's
    // mouth. Better to render nothing.
    for (const d of ["", "gaming", "GENERAL", "general "]) {
      expect(parseUserStatus(status({ d }))).toBeUndefined();
    }
  });

  it("ignores an event of another kind", () => {
    expect(parseUserStatus(status({ kind: 1 }))).toBeUndefined();
  });

  it("keeps an empty status, because clearing is done by publishing one", () => {
    // Deleting a replaceable event is unreliable, so an author clears a status by
    // publishing empty content. That has to parse, or a cleared status reads as a
    // missing one and the old line stays on screen.
    const parsed = parseUserStatus(status({ content: "" }));
    expect(parsed?.content).toBe("");
  });

  it("trims the content", () => {
    expect(parseUserStatus(status({ content: "  hello \n\n" }))?.content).toBe(
      "hello",
    );
  });

  it("carries an https link from the r tag", () => {
    const parsed = parseUserStatus(
      status({
        tags: [
          ["d", "music"],
          ["r", "https://example.com/track"],
        ],
      }),
    );
    expect(parsed?.link).toBe("https://example.com/track");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "not a url",
    "",
  ])("refuses %o as a link", (href) => {
    // An arbitrary string from a stranger, going into an href.
    const parsed = parseUserStatus(
      status({
        tags: [
          ["d", "general"],
          ["r", href],
        ],
      }),
    );
    expect(parsed?.link).toBeUndefined();
  });

  it("reads a numeric expiration and ignores a malformed one", () => {
    expect(
      parseUserStatus(
        status({
          tags: [
            ["d", "general"],
            ["expiration", "1700000600"],
          ],
        }),
      )?.expiresAt,
    ).toBe(1_700_000_600);
    for (const value of ["soon", "", "-5", "0"]) {
      expect(
        parseUserStatus(
          status({
            tags: [
              ["d", "general"],
              ["expiration", value],
            ],
          }),
        )?.expiresAt,
      ).toBeUndefined();
    }
  });
});

describe("isStatusExpired", () => {
  it("is expired at or after the deadline", () => {
    const parsed = parseUserStatus(
      status({
        tags: [
          ["d", "general"],
          ["expiration", String(NOW)],
        ],
      }),
    );
    expect(parsed && isStatusExpired(parsed, NOW)).toBe(true);
    expect(parsed && isStatusExpired(parsed, NOW - 1)).toBe(false);
  });

  it("never expires without an expiration tag", () => {
    const parsed = parseUserStatus(status({}));
    // Open-ended is the author's choice, not an omission to fill with a default.
    expect(parsed && isStatusExpired(parsed, NOW + 86_400 * 365)).toBe(false);
  });
});

describe("currentUserStatus", () => {
  it("prefers general over music", () => {
    // The general line is written deliberately; a music status is usually written by
    // a player on the author's behalf.
    const chosen = currentUserStatus(
      [
        status({ d: "music", content: "a song" }),
        status({ d: "general", content: "shipping" }),
      ],
      NOW,
    );
    expect(chosen?.content).toBe("shipping");
  });

  it("falls back to music when there is no general status", () => {
    expect(
      currentUserStatus([status({ d: "music", content: "a song" })], NOW)?.kind,
    ).toBe("music");
  });

  it("takes the newest per d tag", () => {
    const chosen = currentUserStatus(
      [
        status({ d: "general", content: "old", createdAt: NOW - 100 }),
        status({ d: "general", content: "new", createdAt: NOW }),
      ],
      NOW,
    );
    expect(chosen?.content).toBe("new");
  });

  it("drops an expired status", () => {
    // The failure this prevents: "at the airport ✈️" on a profile eight months later,
    // which is the profile stating something false on the author's behalf.
    const chosen = currentUserStatus(
      [
        status({
          tags: [
            ["d", "general"],
            ["expiration", String(NOW - 1)],
          ],
          content: "at the airport",
        }),
      ],
      NOW,
    );
    expect(chosen).toBeUndefined();
  });

  it("falls through to music when the general status expired", () => {
    const chosen = currentUserStatus(
      [
        status({
          tags: [
            ["d", "general"],
            ["expiration", String(NOW - 1)],
          ],
        }),
        status({ d: "music", content: "a song" }),
      ],
      NOW,
    );
    expect(chosen?.kind).toBe("music");
  });

  it("drops a cleared status", () => {
    expect(
      currentUserStatus([status({ d: "general", content: "  " })], NOW),
    ).toBeUndefined();
  });

  it("is undefined for no events at all", () => {
    expect(currentUserStatus([], NOW)).toBeUndefined();
  });
});
