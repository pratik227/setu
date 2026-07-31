import { describe, expect, it } from "vitest";
import { verifyEventSignature } from "./event";
import { Kind } from "./kinds";
import {
  GiftWrapError,
  giftWrap,
  jitteredTimestamp,
  MAX_TIMESTAMP_JITTER_SECONDS,
  seal,
  toRumor,
  unwrap,
  wrap,
} from "./nip59";
import { LocalSigner } from "./signers/local";
import type { NostrEvent } from "./types";

const NOW = 1_800_000_000;

const alice = LocalSigner.generate();
const bob = LocalSigner.generate();
const eve = LocalSigner.generate();

const verify = (event: NostrEvent) => verifyEventSignature(event);

function chatTemplate(content: string) {
  return { kind: Kind.ChatMessage, content, tags: [] };
}

describe("jitteredTimestamp", () => {
  it("only ever moves backwards", () => {
    // Forwards would put a message in the future, which every client sorts wrong.
    for (const r of [0, 0.5, 0.999999]) {
      const t = jitteredTimestamp(NOW, () => r);
      expect(t).toBeLessThanOrEqual(NOW);
      expect(t).toBeGreaterThanOrEqual(NOW - MAX_TIMESTAMP_JITTER_SECONDS);
    }
  });

  it("stays within two days", () => {
    expect(jitteredTimestamp(NOW, () => 1)).toBe(
      NOW - MAX_TIMESTAMP_JITTER_SECONDS,
    );
  });
});

describe("toRumor", () => {
  it("produces an id and no signature", async () => {
    const rumor = toRumor(chatTemplate("hi"), await alice.pubkey(), NOW);
    expect(rumor.id).toMatch(/^[0-9a-f]{64}$/);
    // A rumor is deniable precisely because it is unsigned.
    expect("sig" in rumor).toBe(false);
  });
});

describe("seal and wrap", () => {
  it("hides the sender on the wrapper and names only the recipient", async () => {
    const bobKey = await bob.pubkey();
    const wraps = await giftWrap({
      template: chatTemplate("hello"),
      recipients: [bobKey],
      signer: alice,
      now: NOW,
    });
    const [envelope] = wraps;
    const aliceKey = await alice.pubkey();

    expect(envelope?.kind).toBe(Kind.GiftWrap);
    // The whole point: nothing on the wire ties this to Alice.
    expect(envelope?.pubkey).not.toBe(aliceKey);
    expect(JSON.stringify(envelope)).not.toContain(aliceKey);
    // Exactly one tag, naming the recipient, because delivery needs it.
    expect(envelope?.tags).toEqual([["p", bobKey]]);
    expect(verifyEventSignature(envelope as NostrEvent)).toBe(true);
  });

  it("uses a fresh ephemeral key for every wrap", async () => {
    const bobKey = await bob.pubkey();
    const first = await giftWrap({
      template: chatTemplate("one"),
      recipients: [bobKey],
      signer: alice,
      now: NOW,
    });
    const second = await giftWrap({
      template: chatTemplate("two"),
      recipients: [bobKey],
      signer: alice,
      now: NOW,
    });
    // Reuse would link every message from this sender into one pseudo-identity.
    expect(first[0]?.pubkey).not.toBe(second[0]?.pubkey);
  });

  it("wraps once per recipient, including the sender", async () => {
    const aliceKey = await alice.pubkey();
    const bobKey = await bob.pubkey();
    const wraps = await giftWrap({
      template: chatTemplate("hi"),
      recipients: [bobKey, aliceKey],
      signer: alice,
      now: NOW,
    });
    expect(wraps).toHaveLength(2);
    expect(wraps.map((w) => w.tags[0]?.[1]).sort()).toEqual(
      [bobKey, aliceKey].sort(),
    );
  });

  it("deduplicates recipients", async () => {
    const bobKey = await bob.pubkey();
    const wraps = await giftWrap({
      template: chatTemplate("hi"),
      recipients: [bobKey, bobKey, bobKey],
      signer: alice,
      now: NOW,
    });
    expect(wraps).toHaveLength(1);
  });

  it("leaves no tags on the seal", async () => {
    const rumor = toRumor(chatTemplate("hi"), await alice.pubkey(), NOW);
    const sealed = await seal({
      rumor,
      recipient: await bob.pubkey(),
      signer: alice,
      now: NOW,
    });
    // A recipient tag here would leak, to anyone who decrypts the wrap, the thing
    // the wrap exists to hide.
    expect(sealed.tags).toEqual([]);
    expect(sealed.kind).toBe(Kind.Seal);
  });
});

describe("unwrap", () => {
  it("round-trips a message to its recipient", async () => {
    const [envelope] = await giftWrap({
      template: chatTemplate("hello bob"),
      recipients: [await bob.pubkey()],
      signer: alice,
      now: NOW,
    });
    const result = await unwrap(envelope as NostrEvent, bob, verify);
    expect(result.rumor.content).toBe("hello bob");
    expect(result.rumor.kind).toBe(Kind.ChatMessage);
    expect(result.sender).toBe(await alice.pubkey());
  });

  it("lets the sender read their own copy", async () => {
    // Without a self-addressed wrap, sent messages are unreadable to their author
    // and the conversation is write-only.
    const aliceKey = await alice.pubkey();
    const wraps = await giftWrap({
      template: chatTemplate("my own words"),
      recipients: [await bob.pubkey(), aliceKey],
      signer: alice,
      now: NOW,
    });
    const mine = wraps.find((w) => w.tags[0]?.[1] === aliceKey);
    const result = await unwrap(mine as NostrEvent, alice, verify);
    expect(result.rumor.content).toBe("my own words");
  });

  it("refuses a message whose rumor claims an author who did not seal it", async () => {
    // THE attack this layer must stop. Eve seals a rumor that says Alice wrote it.
    // The seal signature is valid — it is Eve's — so a client that only checks the
    // signature would show the message as Alice's.
    const aliceKey = await alice.pubkey();
    const bobKey = await bob.pubkey();
    const forged = {
      ...toRumor(chatTemplate("I owe Eve 10 BTC"), aliceKey, NOW),
    };
    const sealed = await seal({
      rumor: forged,
      recipient: bobKey,
      signer: eve,
      now: NOW,
    });
    const envelope = await wrap({ seal: sealed, recipient: bobKey, now: NOW });

    await expect(unwrap(envelope, bob, verify)).rejects.toThrow(GiftWrapError);
    await expect(unwrap(envelope, bob, verify)).rejects.toThrow(
      /claims an author who did not seal it/,
    );
  });

  it("refuses a seal whose signature does not verify", async () => {
    const bobKey = await bob.pubkey();
    const rumor = toRumor(chatTemplate("hi"), await alice.pubkey(), NOW);
    const sealed = await seal({
      rumor,
      recipient: bobKey,
      signer: alice,
      now: NOW,
    });
    const envelope = await wrap({ seal: sealed, recipient: bobKey, now: NOW });
    // A verifier that says no stands in for a tampered seal.
    await expect(unwrap(envelope, bob, () => false)).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("refuses a rumor that arrived carrying a signature", async () => {
    const bobKey = await bob.pubkey();
    const aliceKey = await alice.pubkey();
    const signedRumor = {
      ...toRumor(chatTemplate("hi"), aliceKey, NOW),
      sig: "0".repeat(128),
    };
    const sealed = await seal({
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      rumor: signedRumor as any,
      recipient: bobKey,
      signer: alice,
      now: NOW,
    });
    const envelope = await wrap({ seal: sealed, recipient: bobKey, now: NOW });
    await expect(unwrap(envelope, bob, verify)).rejects.toThrow(
      /carrying a signature/,
    );
  });

  it("cannot be opened by anyone but the recipient", async () => {
    const [envelope] = await giftWrap({
      template: chatTemplate("private"),
      recipients: [await bob.pubkey()],
      signer: alice,
      now: NOW,
    });
    await expect(unwrap(envelope as NostrEvent, eve, verify)).rejects.toThrow();
  });

  it("rejects an event that is not a gift wrap", async () => {
    const notAWrap = await alice.signEvent({
      kind: Kind.ShortTextNote,
      content: "public",
      tags: [],
    });
    await expect(unwrap(notAWrap, bob, verify)).rejects.toThrow(
      /not a gift wrap/,
    );
  });

  it("reports the wrap timestamp separately from the message time", async () => {
    // The wrap's `created_at` is jittered, so it is not the message's time and a
    // caller must not sort by it.
    const [envelope] = await giftWrap({
      template: { ...chatTemplate("hi"), created_at: NOW },
      recipients: [await bob.pubkey()],
      signer: alice,
      now: NOW,
      random: () => 0.5,
    });
    const result = await unwrap(envelope as NostrEvent, bob, verify);
    expect(result.rumor.created_at).toBe(NOW);
    expect(result.wrapCreatedAt).toBeLessThan(NOW);
  });
});
