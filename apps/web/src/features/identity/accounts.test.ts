import { describe, expect, it } from "vitest";
import {
  needsPassphrase,
  removeAccount,
  type StoredAccount,
  upsertAccount,
} from "./accounts";
import { assertPersistable, isStoredSession } from "./storage";

const A = "a".repeat(64);
const B = "b".repeat(64);
const NCRYPTSEC = "ncryptsec1qqqqqqqq";

function account(pubkey: string, addedAt: number): StoredAccount {
  return { kind: "nip07", pubkey, addedAt };
}

describe("upsertAccount", () => {
  it("keys on the pubkey, so an account is never listed twice", () => {
    const list = upsertAccount(
      [account(A, 1)],
      { kind: "nip07", pubkey: A },
      99,
    );
    expect(list).toHaveLength(1);
  });

  it("keeps the original addedAt, so the switcher does not reshuffle on unlock", () => {
    const list = upsertAccount(
      [account(A, 1)],
      { kind: "nip07", pubkey: A },
      99,
    );
    expect(list[0]?.addedAt).toBe(1);
  });

  it("upgrades what we know about an account in place", () => {
    // Signing in again with a key replaces a `readonly` record with an encrypted
    // one for the same identity, rather than adding a second row for it.
    const list = upsertAccount(
      [{ kind: "readonly", pubkey: A, addedAt: 1 }],
      {
        kind: "encrypted",
        pubkey: A,
        ncryptsec: NCRYPTSEC,
      },
      99,
    );
    expect(list).toEqual([
      { kind: "encrypted", pubkey: A, ncryptsec: NCRYPTSEC, addedAt: 1 },
    ]);
  });

  it("orders by when each account was added", () => {
    const list = upsertAccount(
      [account(B, 5)],
      { kind: "nip07", pubkey: A },
      2,
    );
    expect(list.map((entry) => entry.pubkey)).toEqual([A, B]);
  });
});

describe("removeAccount", () => {
  it("drops only the named account", () => {
    expect(
      removeAccount([account(A, 1), account(B, 2)], A).map((e) => e.pubkey),
    ).toEqual([B]);
  });

  it("is a no-op for an account that is not listed", () => {
    const list = [account(A, 1)];
    expect(removeAccount(list, B)).toEqual(list);
  });
});

describe("needsPassphrase", () => {
  it("is true exactly for the records whose secret is encrypted at rest", () => {
    expect(needsPassphrase({ kind: "encrypted", pubkey: A })).toBe(true);
    expect(needsPassphrase({ kind: "nip46", pubkey: A })).toBe(true);
    expect(needsPassphrase({ kind: "nip07", pubkey: A })).toBe(false);
    expect(needsPassphrase({ kind: "readonly", pubkey: A })).toBe(false);
  });
});

describe("isStoredSession", () => {
  it("requires both halves of a nip46 record", () => {
    // A half-record would restore as "signed in" and then never be able to sign.
    const remoteSigner = { pubkey: B, relays: ["wss://relay.example"] };
    expect(
      isStoredSession({
        kind: "nip46",
        pubkey: A,
        ncryptsec: NCRYPTSEC,
        remoteSigner,
      }),
    ).toBe(true);
    expect(isStoredSession({ kind: "nip46", pubkey: A, remoteSigner })).toBe(
      false,
    );
    expect(
      isStoredSession({ kind: "nip46", pubkey: A, ncryptsec: NCRYPTSEC }),
    ).toBe(false);
    expect(
      isStoredSession({
        kind: "nip46",
        pubkey: A,
        ncryptsec: NCRYPTSEC,
        remoteSigner: { pubkey: B, relays: [] },
      }),
    ).toBe(false);
  });

  it("rejects an unknown kind and a malformed pubkey", () => {
    expect(isStoredSession({ kind: "magic", pubkey: A })).toBe(false);
    expect(isStoredSession({ kind: "nip07", pubkey: "short" })).toBe(false);
  });
});

describe("assertPersistable", () => {
  it("refuses a plaintext key or a bunker URI anywhere in the object", () => {
    // Both are signing capabilities. A `bunker://` URI carries its `secret=`
    // parameter, so persisting one persists the ability to sign as that account.
    expect(() =>
      assertPersistable({ kind: "encrypted", ncryptsec: NCRYPTSEC }),
    ).not.toThrow();
    expect(() => assertPersistable({ pubkey: A, note: "nsec1abcdef" })).toThrow(
      /plaintext secret key/,
    );
    expect(() =>
      assertPersistable([{ uri: `bunker://${B}?relay=wss://x&secret=s` }]),
    ).toThrow(/bunker URI/);
  });
});
