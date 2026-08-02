import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPersistable, loadSession } from "./storage";

/**
 * What a stored session is allowed to contain, and what must never load.
 *
 * The validator is the last thing between a corrupt or hostile `localStorage` row
 * and a session the app treats as real. Two classes of failure matter: a record
 * that grants signing it should not, and a record that half-loads into a session
 * which appears signed in but can never sign.
 */

const ACCOUNT = "a".repeat(64);
const SIGNER = "b".repeat(64);

function stubStorage(): Map<string, string> {
  const rows = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
    removeItem: (key: string) => {
      rows.delete(key);
    },
    clear: () => rows.clear(),
    key: (index: number) => [...rows.keys()][index] ?? null,
    get length() {
      return rows.size;
    },
  };
  return rows;
}

let rows: Map<string, string>;

beforeEach(() => {
  rows = stubStorage();
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const base = {
  kind: "nip46",
  pubkey: ACCOUNT,
  ncryptsec: "ncryptsec1abc",
};

function write(remoteSigner: unknown): void {
  rows.set("setu-session", JSON.stringify({ ...base, remoteSigner }));
}

describe("assertPersistable", () => {
  it("refuses a plaintext secret key", () => {
    expect(() =>
      assertPersistable({ note: `nsec1${"q".repeat(58)}` }),
    ).toThrow();
  });

  it("refuses a bunker URI, which carries its own secret", () => {
    expect(() =>
      assertPersistable({ uri: "bunker://abc?relay=wss://a&secret=xyz" }),
    ).toThrow();
  });

  it("allows an ordinary record", () => {
    expect(() => assertPersistable({ ...base })).not.toThrow();
  });
});

describe("stored remote signer scheme", () => {
  it("loads a record carrying a known scheme", () => {
    write({ pubkey: SIGNER, relays: ["wss://a.example"], scheme: "nip04" });
    expect(loadSession()?.remoteSigner?.scheme).toBe("nip04");
  });

  it("loads a record written before the field existed", () => {
    // Absent means "not yet observed", which is the state a first connection is
    // in anyway — an old record must not fail to load over a performance hint.
    write({ pubkey: SIGNER, relays: ["wss://a.example"] });
    expect(loadSession()?.kind).toBe("nip46");
    expect(loadSession()?.remoteSigner?.scheme).toBeUndefined();
  });

  it("refuses a record whose scheme is neither known constant", () => {
    // A junk value would be handed to the signer as fact and would suppress the
    // probe that would have found the truth.
    write({ pubkey: SIGNER, relays: ["wss://a.example"], scheme: "rot13" });
    expect(loadSession()).toBeUndefined();
  });

  it("still refuses a bunker record missing its client key", () => {
    // The pre-existing rule, re-asserted because the scheme field sits beside it:
    // a half-record that restored as "signed in" gives a session that can never
    // sign.
    rows.set(
      "setu-session",
      JSON.stringify({
        kind: "nip46",
        pubkey: ACCOUNT,
        remoteSigner: { pubkey: SIGNER, relays: ["wss://a.example"] },
      }),
    );
    expect(loadSession()).toBeUndefined();
  });
});
