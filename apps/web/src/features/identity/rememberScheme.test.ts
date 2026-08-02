import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberScheme } from "./rememberScheme";
import type { RemoteConnection } from "./remoteSigner";
import type { StoredSession } from "./storage";

/**
 * Persisting the learned NIP-46 encryption scheme.
 *
 * The value is a *performance* hint — one of two public constants, worth one probe
 * if wrong. So the tests are not about correctness of the scheme but about the two
 * ways writing it could damage something that matters: rewriting another account's
 * record, and turning a stored session into one that no longer loads.
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

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    kind: "nip46",
    pubkey: ACCOUNT,
    ncryptsec: "ncryptsec1abc",
    remoteSigner: { pubkey: SIGNER, relays: ["wss://a.example"] },
    ...over,
  } as StoredSession;
}

function connection(
  scheme: "nip04" | "nip44" | undefined,
  over: { user?: string; signer?: string } = {},
): RemoteConnection {
  return {
    userPubkey: over.user ?? ACCOUNT,
    remoteSignerPubkey: over.signer ?? SIGNER,
    observedScheme: () => scheme,
  } as unknown as RemoteConnection;
}

function stored(rows: Map<string, string>): StoredSession | undefined {
  const raw = rows.get("setu-session");
  return raw ? (JSON.parse(raw) as StoredSession) : undefined;
}

let rows: Map<string, string>;

beforeEach(() => {
  rows = stubStorage();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("rememberScheme", () => {
  it("writes the observed scheme onto the stored record", async () => {
    rows.set("setu-session", JSON.stringify(session()));
    rememberScheme(connection("nip04"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(stored(rows)?.remoteSigner?.scheme).toBe("nip04");
  });

  it("keeps everything else on the record intact", async () => {
    // The record also carries the encrypted client key. Losing it would turn a
    // working session into one that cannot sign and cannot be recovered.
    rows.set("setu-session", JSON.stringify(session()));
    rememberScheme(connection("nip44"));
    await vi.advanceTimersByTimeAsync(2000);
    const after = stored(rows);
    expect(after?.ncryptsec).toBe("ncryptsec1abc");
    expect(after?.pubkey).toBe(ACCOUNT);
    expect(after?.remoteSigner?.relays).toEqual(["wss://a.example"]);
  });

  it("never rewrites a different account's record", async () => {
    // The race this guards: the user switches accounts between connecting and the
    // first observed frame. Writing then would stamp the new account's row with
    // the old connection's scheme.
    rows.set(
      "setu-session",
      JSON.stringify(session({ pubkey: "c".repeat(64) })),
    );
    rememberScheme(connection("nip04"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored(rows)?.remoteSigner?.scheme).toBeUndefined();
  });

  it("never rewrites a record belonging to a different signer", async () => {
    rows.set("setu-session", JSON.stringify(session()));
    rememberScheme(connection("nip44", { signer: "d".repeat(64) }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored(rows)?.remoteSigner?.scheme).toBeUndefined();
  });

  it("gives up rather than polling forever when nothing is observed", async () => {
    // A signer that never answers must not leave a timer running for the life of
    // the tab.
    rows.set("setu-session", JSON.stringify(session()));
    rememberScheme(connection(undefined));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stored(rows)?.remoteSigner?.scheme).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not write when the stored value already matches", async () => {
    rows.set(
      "setu-session",
      JSON.stringify(
        session({
          remoteSigner: {
            pubkey: SIGNER,
            relays: ["wss://a.example"],
            scheme: "nip04",
          },
        }),
      ),
    );
    const before = rows.get("setu-session");
    rememberScheme(connection("nip04"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rows.get("setu-session")).toBe(before);
  });

  it("does nothing for a session that is not a bunker", async () => {
    rows.set(
      "setu-session",
      JSON.stringify({ kind: "encrypted", pubkey: ACCOUNT, ncryptsec: "x" }),
    );
    const before = rows.get("setu-session");
    rememberScheme(connection("nip44"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rows.get("setu-session")).toBe(before);
  });
});
