import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetWalletConnection,
  readWalletConnection,
  saveWalletConnection,
  unlockWalletSecret,
  walletSaveMessage,
} from "./walletStorage";

const ACCOUNT = "1".repeat(64);
const WALLET = "a".repeat(64);
const SECRET = "b".repeat(64);
const URI = `nostr+walletconnect://${WALLET}?relay=wss://relay.example&secret=${SECRET}`;
const PASSPHRASE = "correct horse battery staple";

/**
 * The stored connection secret is a spending key. These tests are mostly about the
 * things that must *not* be true of what lands on disk.
 */

/**
 * Minimal `localStorage`, following `localSettings.test.ts`: the key scheme and the
 * persistence are real here, so "what actually lands on disk" is a thing these tests
 * can assert about — which is most of the point for a stored spending key.
 */
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

describe("saveWalletConnection", () => {
  it("stores the pubkey and relays in the clear and the secret as ciphertext", () => {
    const result = saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stored.walletPubkey).toBe(WALLET);
    expect(result.stored.relays).toEqual(["wss://relay.example"]);
    expect(result.stored.ncryptsec.startsWith("ncryptsec1")).toBe(true);
  });

  it("never writes the raw secret anywhere in storage", () => {
    // The test that matters. A stolen backup of localStorage must contain nothing
    // spendable.
    saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    const everything = JSON.stringify([...rows.entries()]);
    expect(everything).not.toContain(SECRET);
  });

  it("never returns the raw secret to the caller", () => {
    // So a caller that renders the result cannot accidentally render the key.
    const result = saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses a bad connection string with its reason", () => {
    const result = saveWalletConnection(
      ACCOUNT,
      "https://example.com",
      PASSPHRASE,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("not-a-wallet-uri");
  });

  it("refuses an empty passphrase rather than storing plaintext", () => {
    const result = saveWalletConnection(ACCOUNT, URI, "");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("encryption-failed");
    expect(readWalletConnection(ACCOUNT)).toBeUndefined();
  });

  it("scopes the connection per account", () => {
    const other = "2".repeat(64);
    saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    expect(readWalletConnection(ACCOUNT)).toBeDefined();
    // A second account must not inherit the first one's wallet.
    expect(readWalletConnection(other)).toBeUndefined();
  });
});

describe("unlockWalletSecret", () => {
  it("returns the original key for the right passphrase", () => {
    const saved = saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    if (!saved.ok) throw new Error("save failed");
    const bytes = unlockWalletSecret(saved.stored, PASSPHRASE);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
    const hex = [...(bytes ?? [])]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(SECRET);
  });

  it("returns undefined for the wrong passphrase", () => {
    const saved = saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    if (!saved.ok) throw new Error("save failed");
    expect(unlockWalletSecret(saved.stored, "wrong")).toBeUndefined();
  });
});

describe("readWalletConnection", () => {
  it("is undefined with no account or no stored row", () => {
    expect(readWalletConnection(undefined)).toBeUndefined();
    expect(readWalletConnection(ACCOUNT)).toBeUndefined();
  });

  it.each([
    ["not json", "{{{"],
    ["not an object", '"a string"'],
    ["a missing pubkey", '{"relays":["wss://a"],"ncryptsec":"ncryptsec1x"}'],
    ["a missing ncryptsec", '{"walletPubkey":"a","relays":["wss://a"]}'],
    [
      "a plaintext secret where ciphertext belongs",
      `{"walletPubkey":"a","relays":["wss://a"],"ncryptsec":"${SECRET}"}`,
    ],
    [
      "relays not an array",
      '{"walletPubkey":"a","relays":"wss://a","ncryptsec":"ncryptsec1x"}',
    ],
    [
      "an empty relay list",
      '{"walletPubkey":"a","relays":[],"ncryptsec":"ncryptsec1x"}',
    ],
  ])("treats %s as no wallet configured", (_label, raw) => {
    // A corrupt row must not become a connection whose relay list is not an array —
    // that throws inside the transport rather than at the read.
    rows.set(`setu-wallet:${ACCOUNT}`, raw);
    expect(readWalletConnection(ACCOUNT)).toBeUndefined();
  });

  it("drops non-string relay entries but keeps the row", () => {
    rows.set(
      `setu-wallet:${ACCOUNT}`,
      JSON.stringify({
        walletPubkey: WALLET,
        relays: ["wss://a.example", 42, "", null, "wss://b.example"],
        ncryptsec: "ncryptsec1valid",
      }),
    );
    expect(readWalletConnection(ACCOUNT)?.relays).toEqual([
      "wss://a.example",
      "wss://b.example",
    ]);
  });
});

describe("forgetWalletConnection", () => {
  it("removes the row entirely", () => {
    // Not blanked: a leftover ncryptsec is still a spending key waiting for a
    // passphrase guess.
    saveWalletConnection(ACCOUNT, URI, PASSPHRASE);
    forgetWalletConnection(ACCOUNT);
    expect(readWalletConnection(ACCOUNT)).toBeUndefined();
    expect(rows.has(`setu-wallet:${ACCOUNT}`)).toBe(false);
  });

  it("is a no-op with no account", () => {
    expect(() => forgetWalletConnection(undefined)).not.toThrow();
  });
});

describe("walletSaveMessage", () => {
  it("words every reason without echoing the input", () => {
    for (const reason of [
      "encryption-failed",
      "not-a-wallet-uri",
      "bad-secret",
      "missing-relay",
    ] as const) {
      const message = walletSaveMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(SECRET);
    }
  });
});
