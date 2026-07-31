import { Kind, type NostrEvent } from "@setu/protocol";
import { describe, expect, it } from "vitest";
import { editProfile, parseProfileObject, profileFields } from "./profileEdit";
import { editDmRelayList, editRelayList, relayEntries } from "./relayListEdit";

const A = "wss://a.example.com";
const B = "wss://b.example.com";

function event(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: "2".repeat(64),
    created_at: 1000,
    kind: Kind.RelayList,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

describe("relayEntries", () => {
  it("treats an unmarked relay as both read and write", () => {
    // NIP-65's default. Reading it as read-only would quietly stop publishing.
    expect(relayEntries(event({ tags: [["r", A]] }))).toEqual([
      { url: A, read: true, write: true },
    ]);
  });

  it("honours read and write markers", () => {
    expect(
      relayEntries(
        event({
          tags: [
            ["r", A, "read"],
            ["r", B, "write"],
          ],
        }),
      ),
    ).toEqual([
      { url: A, read: true, write: false },
      { url: B, read: false, write: true },
    ]);
  });

  it("ignores non-r tags and duplicates", () => {
    expect(
      relayEntries(event({ tags: [["r", A], ["p", "x"], ["r", A], ["r"]] })),
    ).toEqual([{ url: A, read: true, write: true }]);
  });

  it("returns nothing for a wrong-kind or missing event", () => {
    expect(relayEntries(undefined)).toEqual([]);
    expect(relayEntries(event({ kind: Kind.Metadata }))).toEqual([]);
  });
});

describe("editRelayList", () => {
  it("refuses to create a first list from an unconfirmed absence", () => {
    // The destructive case: writing a one-entry list because the real one had not
    // arrived yet replaces a working list with whatever is on screen.
    expect(
      editRelayList({
        current: undefined,
        absenceConfirmed: false,
        next: [{ url: A, read: true, write: true }],
      }),
    ).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("creates a first list once absence is confirmed", () => {
    const result = editRelayList({
      current: undefined,
      absenceConfirmed: true,
      next: [{ url: A, read: true, write: true }],
    });
    expect(result.ok).toBe(true);
  });

  it("refuses to publish an empty list", () => {
    // Not "no preference" — an active statement that you can be reached nowhere.
    expect(
      editRelayList({
        current: event({ tags: [["r", A]] }),
        absenceConfirmed: true,
        next: [],
      }),
    ).toEqual({ ok: false, reason: "would-empty" });
  });

  it("drops a relay marked neither read nor write", () => {
    const result = editRelayList({
      current: event({ tags: [["r", A]] }),
      absenceConfirmed: true,
      next: [
        { url: A, read: true, write: true },
        { url: B, read: false, write: false },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: "no-change" });
  });

  it("preserves tags it does not understand", () => {
    // A rebuild that emits only `r` tags deletes whatever else the list held.
    const current = event({
      tags: [
        ["r", A],
        ["alt", "my relays"],
        ["client", "something"],
      ],
    });
    const result = editRelayList({
      current,
      absenceConfirmed: true,
      next: [
        { url: A, read: true, write: true },
        { url: B, read: true, write: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toContainEqual(["alt", "my relays"]);
    expect(result.template.tags).toContainEqual(["client", "something"]);
  });

  it("preserves content", () => {
    const current = event({ tags: [["r", A]], content: "do not lose me" });
    const result = editRelayList({
      current,
      absenceConfirmed: true,
      next: [
        { url: A, read: true, write: true },
        { url: B, read: true, write: true },
      ],
    });
    expect(result.ok && result.template.content).toBe("do not lose me");
  });

  it("emits a marker only for one-way relays", () => {
    const result = editRelayList({
      current: event({ tags: [["r", A]] }),
      absenceConfirmed: true,
      next: [
        { url: A, read: true, write: true },
        { url: B, read: true, write: false },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toContainEqual(["r", A]);
    expect(result.template.tags).toContainEqual(["r", B, "read"]);
  });

  it("reports no change when the list is identical", () => {
    expect(
      editRelayList({
        current: event({ tags: [["r", A]] }),
        absenceConfirmed: true,
        next: [{ url: A, read: true, write: true }],
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });
});

describe("editDmRelayList", () => {
  const dm = (tags: string[][]) =>
    event({ kind: Kind.DirectMessageRelays, tags });

  it("refuses an unconfirmed absence", () => {
    expect(
      editDmRelayList({
        current: undefined,
        absenceConfirmed: false,
        next: [A],
      }),
    ).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("refuses to publish an empty list", () => {
    // Publishing no DM relays means nobody can send you a private message —
    // senders have nowhere to deliver and correctly will not guess.
    expect(
      editDmRelayList({
        current: dm([["relay", A]]),
        absenceConfirmed: true,
        next: [],
      }),
    ).toEqual({ ok: false, reason: "would-empty" });
  });

  it("writes relay tags and preserves others", () => {
    const result = editDmRelayList({
      current: dm([
        ["relay", A],
        ["alt", "inbox"],
      ]),
      absenceConfirmed: true,
      next: [A, B],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.tags).toContainEqual(["relay", A]);
    expect(result.template.tags).toContainEqual(["relay", B]);
    expect(result.template.tags).toContainEqual(["alt", "inbox"]);
  });

  it("deduplicates and reports no change", () => {
    expect(
      editDmRelayList({
        current: dm([["relay", A]]),
        absenceConfirmed: true,
        next: [A, A, " "],
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });
});

describe("profile editing", () => {
  const profile = (content: string, tags: string[][] = []) =>
    event({ kind: Kind.Metadata, content, tags });

  it("tolerates content that is not a JSON object", () => {
    for (const content of ["", "not json", "[]", "null", '"a string"']) {
      expect(parseProfileObject(profile(content))).toEqual({});
    }
  });

  it("reads only string fields into the form", () => {
    const fields = profileFields(
      profile(JSON.stringify({ name: "Ada", bot: false, about: "hi" })),
    );
    expect(fields).toEqual({ name: "Ada", about: "hi" });
  });

  it("preserves fields the form does not know about", () => {
    // The quiet, permanent failure this prevents: editing a display name in one
    // client and losing your lightning address and banner everywhere.
    const current = profile(
      JSON.stringify({
        name: "Ada",
        lud16: "ada@example.com",
        birthday: "1815-12-10",
        somethingCustom: { nested: true },
      }),
    );
    const result = editProfile({
      current,
      absenceConfirmed: true,
      fields: { name: "Ada Lovelace" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = JSON.parse(result.template.content);
    expect(written).toEqual({
      name: "Ada Lovelace",
      lud16: "ada@example.com",
      birthday: "1815-12-10",
      somethingCustom: { nested: true },
    });
  });

  it("deletes a key when the field is emptied", () => {
    // Cleaner than publishing `""`, which other clients will render as a value.
    const current = profile(JSON.stringify({ name: "Ada", about: "engineer" }));
    const result = editProfile({
      current,
      absenceConfirmed: true,
      fields: { about: "   " },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.template.content)).toEqual({ name: "Ada" });
  });

  it("trims values", () => {
    const result = editProfile({
      current: profile("{}"),
      absenceConfirmed: true,
      fields: { name: "  Ada  " },
    });
    expect(result.ok && JSON.parse(result.template.content).name).toBe("Ada");
  });

  it("preserves tags", () => {
    const current = profile("{}", [["alt", "profile"]]);
    const result = editProfile({
      current,
      absenceConfirmed: true,
      fields: { name: "Ada" },
    });
    expect(result.ok && result.template.tags).toContainEqual([
      "alt",
      "profile",
    ]);
  });

  it("refuses an unconfirmed absence", () => {
    // Publishing from an empty form because the fetch had not landed would erase
    // a profile the reader never saw.
    expect(
      editProfile({
        current: undefined,
        absenceConfirmed: false,
        fields: { name: "Ada" },
      }),
    ).toEqual({ ok: false, reason: "unverified-absence" });
  });

  it("reports no change when nothing differs", () => {
    const current = profile(JSON.stringify({ name: "Ada" }));
    expect(
      editProfile({
        current,
        absenceConfirmed: true,
        fields: { name: "Ada" },
      }),
    ).toEqual({ ok: false, reason: "no-change" });
  });
});
