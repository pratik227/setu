import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lockWalletSession,
  lockWalletSessionUnless,
  noteWalletCapabilities,
  openWalletSession,
  subscribeWalletSession,
  walletCapabilities,
  walletSessionSecret,
  walletSessionState,
} from "./walletSession";

/**
 * The slot that holds a spending key in memory.
 *
 * Two properties are worth a test each. The account gate is a security property: one
 * account's connection key must be unreachable while another is signed in, and the gate
 * is the only thing enforcing it now that the key is no longer per-component state. The
 * no-op-on-unchanged-capabilities rule is a correctness property: the capability write is
 * driven by a store observer that re-fires on every relay tick, and a store that
 * published every time would re-render every subscriber continuously.
 */

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

afterEach(() => {
  lockWalletSession();
});

describe("walletSessionSecret", () => {
  it("hands the secret only to the account that unlocked it", () => {
    // The failure this prevents: switching accounts and finding the previous account's
    // wallet still spendable from the new session.
    openWalletSession(ALICE, new Uint8Array([1, 2, 3]));
    expect(walletSessionSecret(ALICE)).toEqual(new Uint8Array([1, 2, 3]));
    expect(walletSessionSecret(BOB)).toBeUndefined();
    expect(walletSessionSecret(undefined)).toBeUndefined();
  });

  it("replaces the slot rather than keeping both accounts", () => {
    // One slot, not a map: a map would keep the first account's key alive for the
    // lifetime of the page.
    openWalletSession(ALICE, new Uint8Array([1]));
    openWalletSession(BOB, new Uint8Array([2]));
    expect(walletSessionSecret(ALICE)).toBeUndefined();
    expect(walletSessionSecret(BOB)).toEqual(new Uint8Array([2]));
  });

  it("is empty after locking", () => {
    openWalletSession(ALICE, new Uint8Array([1]));
    lockWalletSession();
    expect(walletSessionSecret(ALICE)).toBeUndefined();
  });

  it("drops a slot belonging to another account on sign-in", () => {
    openWalletSession(ALICE, new Uint8Array([1]));
    lockWalletSessionUnless(BOB);
    expect(walletSessionSecret(ALICE)).toBeUndefined();
  });

  it("keeps the slot when the same account is re-asserted", () => {
    // Called from an effect on every mount; re-locking there would make the wallet
    // appear to lock itself whenever a surface mounted.
    openWalletSession(ALICE, new Uint8Array([1]));
    lockWalletSessionUnless(ALICE);
    expect(walletSessionSecret(ALICE)).toEqual(new Uint8Array([1]));
  });
});

describe("noteWalletCapabilities", () => {
  it("keeps the unlocked key when capabilities arrive for the same account", () => {
    openWalletSession(ALICE, new Uint8Array([9]));
    noteWalletCapabilities(ALICE, { nip44: true, methods: ["pay_invoice"] });
    expect(walletSessionSecret(ALICE)).toEqual(new Uint8Array([9]));
    expect(walletCapabilities(ALICE)).toEqual({
      nip44: true,
      methods: ["pay_invoice"],
    });
  });

  it("never resurrects another account's key", () => {
    openWalletSession(ALICE, new Uint8Array([9]));
    noteWalletCapabilities(BOB, { nip44: true, methods: ["pay_invoice"] });
    expect(walletSessionSecret(BOB)).toBeUndefined();
    expect(walletSessionSecret(ALICE)).toBeUndefined();
  });

  it("survives being learnt before the unlock", () => {
    // The info event is readable while the connection is still locked. Throwing it away
    // on unlock would mean the first payment attempt discovers NOT_IMPLEMENTED.
    noteWalletCapabilities(ALICE, { nip44: true, methods: ["pay_invoice"] });
    openWalletSession(ALICE, new Uint8Array([7]));
    expect(walletCapabilities(ALICE).methods).toEqual(["pay_invoice"]);
  });

  it("reports no capabilities for an account that does not own the slot", () => {
    noteWalletCapabilities(ALICE, { nip44: true, methods: ["pay_invoice"] });
    expect(walletCapabilities(BOB)).toEqual({ nip44: false, methods: [] });
  });
});

describe("the store's notifications", () => {
  it("does not fire when the capabilities are unchanged", () => {
    /*
     * Driven by a store observer that re-emits whenever the info event is re-delivered,
     * which on a live relay is often. Publishing an identical snapshot would re-render
     * every subscriber — including every note row, through the payer hook — on each
     * tick, which is the churn `useNoteRowActions` measured and designed against.
     */
    noteWalletCapabilities(ALICE, { nip44: false, methods: ["get_balance"] });
    const listener = vi.fn();
    const unsubscribe = subscribeWalletSession(listener);
    const before = walletSessionState();
    try {
      noteWalletCapabilities(ALICE, {
        nip44: false,
        methods: ["get_balance"],
      });
      expect(listener).not.toHaveBeenCalled();
      // Identity preserved is what `useSyncExternalStore` actually compares.
      expect(walletSessionState()).toBe(before);

      noteWalletCapabilities(ALICE, {
        nip44: false,
        methods: ["get_balance", "pay_invoice"],
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(walletSessionState()).not.toBe(before);
    } finally {
      unsubscribe();
    }
  });

  it("fires when a wallet is unlocked, so a mounted feed sees it", () => {
    // The whole reason this is a module store: the note row's payer has to notice an
    // unlock that happened on a different screen.
    const listener = vi.fn();
    const unsubscribe = subscribeWalletSession(listener);
    try {
      openWalletSession(ALICE, new Uint8Array([4]));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
});
