import { beforeEach, describe, expect, it } from "vitest";
import type { ArticleDraft } from "./buildArticle";
import {
  deleteLocalDraft,
  type LocalDraftStorage,
  listLocalDrafts,
  loadLocalDraft,
  localDraftKey,
  MAX_LOCAL_DRAFT_CHARS,
  saveLocalDraft,
} from "./localArticleStore";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

/** In-memory `Storage`, so the store is tested without a DOM. */
class FakeStorage implements LocalDraftStorage {
  private readonly map = new Map<string, string>();
  /** Set to make every write throw, as a full quota does. */
  throwOnWrite = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  /** Write a raw value, bypassing serialization, to simulate corruption. */
  poke(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const draft = (over: Partial<ArticleDraft> = {}): ArticleDraft => ({
  identifier: "on-relays-1a2b",
  title: "On Relays",
  content: "A body.",
  ...over,
});

let storage: FakeStorage;
beforeEach(() => {
  storage = new FakeStorage();
});

describe("key scheme", () => {
  it("scopes a key by pubkey and identifier", () => {
    expect(localDraftKey(ALICE, "slug-1a2b")).toBe(
      `setu-article-draft:${ALICE}:slug-1a2b`,
    );
  });

  it("keeps two accounts on the same browser apart", () => {
    // Unpublished writing leaking between accounts sharing a machine is the
    // failure this scoping exists to prevent.
    saveLocalDraft(ALICE, draft({ content: "alice's words" }), 1, storage);
    saveLocalDraft(BOB, draft({ content: "bob's words" }), 2, storage);
    expect(loadLocalDraft(ALICE, "on-relays-1a2b", storage)?.content).toBe(
      "alice's words",
    );
    expect(loadLocalDraft(BOB, "on-relays-1a2b", storage)?.content).toBe(
      "bob's words",
    );
    expect(listLocalDrafts(ALICE, storage)).toHaveLength(1);
  });

  it("keeps one identifier stable across saves rather than accumulating copies", () => {
    // The identifier is the article's address: re-saving must overwrite, or an
    // afternoon of autosaves becomes an afternoon of drafts.
    saveLocalDraft(ALICE, draft({ content: "v1" }), 1, storage);
    saveLocalDraft(ALICE, draft({ content: "v2" }), 2, storage);
    saveLocalDraft(ALICE, draft({ content: "v3" }), 3, storage);
    expect(storage.length).toBe(1);
    expect(loadLocalDraft(ALICE, "on-relays-1a2b", storage)?.content).toBe(
      "v3",
    );
  });
});

describe("save and load", () => {
  it("round-trips every field", () => {
    const full = draft({
      summary: "A summary",
      image: "https://example.com/cover.png",
      hashtags: ["nostr", "relays"],
      publishedAt: 1_700_000_000,
    });
    expect(saveLocalDraft(ALICE, full, 1234, storage)).toBe("ok");
    expect(loadLocalDraft(ALICE, full.identifier, storage)).toEqual({
      identifier: "on-relays-1a2b",
      title: "On Relays",
      content: "A body.",
      summary: "A summary",
      image: "https://example.com/cover.png",
      hashtags: ["nostr", "relays"],
      publishedAt: 1_700_000_000,
      savedAt: 1234,
    });
  });

  it("preserves publishedAt, which a re-publish depends on", () => {
    // Losing it here would make a corrected article look newly written.
    saveLocalDraft(ALICE, draft({ publishedAt: 999 }), 1, storage);
    expect(loadLocalDraft(ALICE, "on-relays-1a2b", storage)?.publishedAt).toBe(
      999,
    );
  });

  it("returns undefined for an article that was never saved", () => {
    expect(loadLocalDraft(ALICE, "never-written", storage)).toBeUndefined();
  });

  it("reports unavailable storage instead of throwing", () => {
    expect(saveLocalDraft(ALICE, draft(), 1, undefined)).toBe("unavailable");
    expect(loadLocalDraft(ALICE, "x", undefined)).toBeUndefined();
    expect(listLocalDrafts(ALICE, undefined)).toEqual([]);
    expect(() => deleteLocalDraft(ALICE, "x", undefined)).not.toThrow();
  });

  it("reports a failed write instead of throwing", () => {
    // A full quota must degrade the "saved locally" indicator, not crash the
    // editor the author is typing into.
    storage.throwOnWrite = true;
    expect(saveLocalDraft(ALICE, draft(), 1, storage)).toBe("failed");
  });

  it("refuses an entry large enough to exhaust the origin's quota", () => {
    // Filling `localStorage` does not just fail this write — it fails every
    // other write on the origin, including the session record.
    const huge = draft({ content: "x".repeat(MAX_LOCAL_DRAFT_CHARS + 1) });
    expect(saveLocalDraft(ALICE, huge, 1, storage)).toBe("too-large");
    expect(storage.length).toBe(0);
  });
});

describe("list", () => {
  it("returns every draft for the author, newest save first", () => {
    saveLocalDraft(ALICE, draft({ identifier: "one" }), 100, storage);
    saveLocalDraft(ALICE, draft({ identifier: "two" }), 300, storage);
    saveLocalDraft(ALICE, draft({ identifier: "three" }), 200, storage);
    expect(listLocalDrafts(ALICE, storage).map((d) => d.identifier)).toEqual([
      "two",
      "three",
      "one",
    ]);
  });

  it("returns an empty list for an author with nothing saved", () => {
    saveLocalDraft(BOB, draft(), 1, storage);
    expect(listLocalDrafts(ALICE, storage)).toEqual([]);
  });

  it("ignores unrelated keys sharing the origin", () => {
    storage.poke("setu-session", '{"kind":"nip07"}');
    storage.poke("some-other-app", "junk");
    saveLocalDraft(ALICE, draft(), 1, storage);
    expect(listLocalDrafts(ALICE, storage)).toHaveLength(1);
  });
});

describe("delete", () => {
  it("removes only the named draft", () => {
    saveLocalDraft(ALICE, draft({ identifier: "one" }), 1, storage);
    saveLocalDraft(ALICE, draft({ identifier: "two" }), 2, storage);
    deleteLocalDraft(ALICE, "one", storage);
    expect(loadLocalDraft(ALICE, "one", storage)).toBeUndefined();
    expect(loadLocalDraft(ALICE, "two", storage)).toBeDefined();
  });

  it("is a no-op for a draft that is not there", () => {
    expect(() => deleteLocalDraft(ALICE, "absent", storage)).not.toThrow();
  });
});

describe("corrupt and hostile entries", () => {
  const key = localDraftKey(ALICE, "on-relays-1a2b");

  const BAD: readonly [string, string][] = [
    ["not JSON at all", "}{"],
    ["truncated JSON", '{"identifier":"on-relays-1a2b","tit'],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON string", '"a string"'],
    ["JSON number", "42"],
    ["empty string", ""],
    [
      "object missing content",
      '{"identifier":"on-relays-1a2b","title":"t","savedAt":1}',
    ],
    ["object missing identifier", '{"title":"t","content":"c","savedAt":1}'],
    [
      "empty identifier",
      '{"identifier":"","title":"t","content":"c","savedAt":1}',
    ],
    [
      "non-numeric savedAt",
      '{"identifier":"on-relays-1a2b","title":"t","content":"c","savedAt":"soon"}',
    ],
    [
      "NaN savedAt",
      '{"identifier":"on-relays-1a2b","title":"t","content":"c","savedAt":null}',
    ],
    [
      "wrong types",
      '{"identifier":"on-relays-1a2b","title":42,"content":[],"savedAt":1}',
    ],
  ];

  it.each(BAD)("ignores %s rather than throwing", (_label, raw) => {
    storage.poke(key, raw);
    expect(() =>
      loadLocalDraft(ALICE, "on-relays-1a2b", storage),
    ).not.toThrow();
    expect(loadLocalDraft(ALICE, "on-relays-1a2b", storage)).toBeUndefined();
  });

  it("skips a corrupt entry while still listing the good ones", () => {
    // One bad row, whatever wrote it, must not make the whole drafts list empty.
    saveLocalDraft(ALICE, draft({ identifier: "good" }), 5, storage);
    storage.poke(localDraftKey(ALICE, "bad"), "}{");
    const list = listLocalDrafts(ALICE, storage);
    expect(list).toHaveLength(1);
    expect(list[0]?.identifier).toBe("good");
  });

  it("ignores an oversized entry on read", () => {
    // Written by an older build, or by hand. Parsing megabytes on every editor
    // open is a cost with no upside.
    storage.poke(key, `"${"x".repeat(MAX_LOCAL_DRAFT_CHARS + 10)}"`);
    expect(loadLocalDraft(ALICE, "on-relays-1a2b", storage)).toBeUndefined();
  });

  it("refuses an entry whose payload identifier disagrees with its key", () => {
    // Otherwise one row could masquerade as a different article and the editor
    // would save the author's edits over the wrong address.
    storage.poke(
      key,
      '{"identifier":"some-other-article","title":"t","content":"c","savedAt":1}',
    );
    expect(loadLocalDraft(ALICE, "on-relays-1a2b", storage)).toBeUndefined();
  });

  it("does not let a prototype-polluting payload through", () => {
    storage.poke(
      key,
      '{"__proto__":{"polluted":true},"identifier":"on-relays-1a2b","title":"t","content":"c","savedAt":1}',
    );
    loadLocalDraft(ALICE, "on-relays-1a2b", storage);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
