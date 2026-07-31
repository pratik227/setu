import { describe, expect, it } from "vitest";
import { verifyEventSignature } from "./event";
import { decryptSecretKey, encryptSecretKey, isNcryptsec } from "./nip49";
import {
  generateSecretKey,
  getPublicKey,
  isNip07Available,
  isReadonly,
  LocalSigner,
  Nip07Signer,
  parseSecretKey,
  ReadonlySigner,
} from "./signers";
import { SignerError } from "./types";

const SECRET_HEX =
  "5426e4dbdda01dd54f0d5b1d1a0e9db4c8b3d0e5a2b1f4c7d9e8a6b5c4d3e2f1";
const PUBKEY =
  "53aba620395a09ade0d0115678215b1d565f680adeef7a5c385988a49447eb3c";
const NSEC = "nsec12snwfk7a5qwa2ncdtvw35r5aknyt858952clf37eazntt3xnutcs7rnylr";
const NPUB = "npub12w46vgpetgy6mcxsz9t8sg2mr4t976q2mmhh5hpctxy2f9z8av7qktfcnk";

describe("key helpers", () => {
  it("derives the expected pubkey", () => {
    const bytes = parseSecretKey(SECRET_HEX);
    expect(bytes).toBeDefined();
    expect(getPublicKey(bytes as Uint8Array)).toBe(PUBKEY);
  });

  it("generates 32-byte keys", () => {
    const sk = generateSecretKey();
    expect(sk).toHaveLength(32);
    expect(getPublicKey(sk)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses hex, nsec and raw bytes", () => {
    expect(parseSecretKey(SECRET_HEX)).toHaveLength(32);
    expect(parseSecretKey(` ${SECRET_HEX.toUpperCase()} `)).toHaveLength(32);
    expect(parseSecretKey(NSEC)).toHaveLength(32);
    expect(parseSecretKey(`nostr:${NSEC}`)).toHaveLength(32);
    expect(parseSecretKey(new Uint8Array(32))).toHaveLength(32);
  });

  it("rejects non-keys without throwing", () => {
    expect(parseSecretKey("")).toBeUndefined();
    expect(parseSecretKey("   ")).toBeUndefined();
    expect(parseSecretKey("nope")).toBeUndefined();
    expect(parseSecretKey(SECRET_HEX.slice(0, 62))).toBeUndefined();
    expect(parseSecretKey("z".repeat(64))).toBeUndefined();
    expect(parseSecretKey("nsec1notvalid")).toBeUndefined();
    expect(parseSecretKey(NPUB)).toBeUndefined();
    expect(parseSecretKey(new Uint8Array(31))).toBeUndefined();
  });
});

describe("LocalSigner", () => {
  it("reports its kind and pubkey", async () => {
    const signer = LocalSigner.fromSecretKey(SECRET_HEX);
    expect(signer.kind).toBe("local");
    await expect(signer.pubkey()).resolves.toBe(PUBKEY);
    expect(signer.pubkeySync()).toBe(PUBKEY);
    expect(isReadonly(signer)).toBe(false);
  });

  it("accepts an nsec", async () => {
    await expect(LocalSigner.fromSecretKey(NSEC).pubkey()).resolves.toBe(
      PUBKEY,
    );
  });

  it("signs a verifiable event and fills in pubkey and created_at", async () => {
    const signer = LocalSigner.fromSecretKey(SECRET_HEX);
    const before = Math.floor(Date.now() / 1000);
    const event = await signer.signEvent({ kind: 1, content: "gm" });
    expect(event.pubkey).toBe(PUBKEY);
    expect(event.kind).toBe(1);
    expect(event.tags).toEqual([]);
    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(verifyEventSignature(event)).toBe(true);
  });

  it("preserves supplied tags and created_at", async () => {
    const signer = LocalSigner.fromSecretKey(SECRET_HEX);
    const event = await signer.signEvent({
      kind: 7,
      content: "+",
      tags: [["e", "a".repeat(64)]],
      created_at: 1700000000,
    });
    expect(event.created_at).toBe(1700000000);
    expect(event.tags).toEqual([["e", "a".repeat(64)]]);
    expect(verifyEventSignature(event)).toBe(true);
  });

  it("returns a plain object with no hidden verification marker", async () => {
    const signer = LocalSigner.fromSecretKey(SECRET_HEX);
    const event = await signer.signEvent({ kind: 1, content: "gm" });
    expect(Reflect.ownKeys(event)).toEqual([
      "id",
      "pubkey",
      "created_at",
      "kind",
      "tags",
      "content",
      "sig",
    ]);
  });

  it("throws SignerError on a bad key and stays quiet with tryFrom", () => {
    expect(() => LocalSigner.fromSecretKey("nope")).toThrow(SignerError);
    expect(LocalSigner.tryFromSecretKey("nope")).toBeUndefined();
    expect(LocalSigner.tryFromSecretKey(SECRET_HEX)).toBeDefined();
  });

  it("generates a working signer", async () => {
    const signer = LocalSigner.generate();
    const event = await signer.signEvent({ kind: 1, content: "new identity" });
    expect(event.pubkey).toBe(await signer.pubkey());
    expect(verifyEventSignature(event)).toBe(true);
  });

  it("round-trips a NIP-44 message between two identities", async () => {
    const alice = LocalSigner.fromSecretKey(SECRET_HEX);
    const bob = LocalSigner.generate();
    const alicePk = await alice.pubkey();
    const bobPk = await bob.pubkey();

    const ciphertext = await alice.nip44Encrypt(bobPk, "meet at the bridge");
    expect(ciphertext).not.toContain("bridge");
    await expect(bob.nip44Decrypt(alicePk, ciphertext)).resolves.toBe(
      "meet at the bridge",
    );
  });

  it("rejects a NIP-44 decrypt of garbage", async () => {
    const signer = LocalSigner.fromSecretKey(SECRET_HEX);
    await expect(
      signer.nip44Decrypt(PUBKEY, "not-a-payload"),
    ).rejects.toBeInstanceOf(SignerError);
  });
});

describe("ReadonlySigner", () => {
  it("accepts hex and npub", async () => {
    await expect(ReadonlySigner.fromPubkey(PUBKEY).pubkey()).resolves.toBe(
      PUBKEY,
    );
    await expect(ReadonlySigner.fromPubkey(NPUB).pubkey()).resolves.toBe(
      PUBKEY,
    );
    await expect(
      ReadonlySigner.fromPubkey(` ${PUBKEY.toUpperCase()} `).pubkey(),
    ).resolves.toBe(PUBKEY);
  });

  it("is a first-class read-only mode", () => {
    const signer = ReadonlySigner.fromPubkey(NPUB);
    expect(signer.kind).toBe("readonly");
    expect(isReadonly(signer)).toBe(true);
    expect(signer.pubkeySync()).toBe(PUBKEY);
  });

  it("rejects signing with a SignerError instead of crashing", async () => {
    const signer = ReadonlySigner.fromPubkey(NPUB);
    await expect(
      signer.signEvent({ kind: 1, content: "gm" }),
    ).rejects.toBeInstanceOf(SignerError);
    await expect(signer.signEvent({ kind: 1, content: "gm" })).rejects.toThrow(
      /read-only/,
    );
  });

  it("rejects inputs that are not public keys", () => {
    expect(ReadonlySigner.tryFromPubkey(NSEC)).toBeUndefined();
    expect(ReadonlySigner.tryFromPubkey("nope")).toBeUndefined();
    expect(ReadonlySigner.tryFromPubkey("")).toBeUndefined();
    expect(() => ReadonlySigner.fromPubkey("nope")).toThrow(SignerError);
  });
});

describe("Nip07Signer", () => {
  it("reports absence rather than pretending", () => {
    expect(isNip07Available()).toBe(false);
    expect(Nip07Signer.detect()).toBeUndefined();
    expect(() => Nip07Signer.fromWindow()).toThrow(SignerError);
  });

  it("feature-detects nip44 support", async () => {
    const withoutNip44 = new Nip07Signer({
      getPublicKey: () => Promise.resolve(PUBKEY),
      signEvent: () => Promise.reject(new Error("unused")),
    });
    expect(withoutNip44.nip44Encrypt).toBeUndefined();
    expect(withoutNip44.nip44Decrypt).toBeUndefined();
    await expect(withoutNip44.pubkey()).resolves.toBe(PUBKEY);

    const withNip44 = new Nip07Signer({
      getPublicKey: () => Promise.resolve(PUBKEY),
      signEvent: () => Promise.reject(new Error("unused")),
      nip44: {
        encrypt: (_peer, plaintext) => Promise.resolve(`enc:${plaintext}`),
        decrypt: (_peer, ciphertext) =>
          Promise.resolve(ciphertext.replace("enc:", "")),
      },
    });
    expect(withNip44.nip44Encrypt).toBeDefined();
    await expect(withNip44.nip44Encrypt?.(PUBKEY, "hi")).resolves.toBe(
      "enc:hi",
    );
  });

  it("wraps provider failures in SignerError", async () => {
    const signer = new Nip07Signer({
      getPublicKey: () => Promise.reject(new Error("user declined")),
      signEvent: () => Promise.reject(new Error("user declined")),
    });
    await expect(signer.pubkey()).rejects.toBeInstanceOf(SignerError);
    await expect(
      signer.signEvent({ kind: 1, content: "gm" }),
    ).rejects.toBeInstanceOf(SignerError);
  });

  it("rejects a malformed pubkey from the extension", async () => {
    const signer = new Nip07Signer({
      getPublicKey: () => Promise.resolve("not-a-key"),
      signEvent: () => Promise.reject(new Error("unused")),
    });
    await expect(signer.pubkey()).rejects.toBeInstanceOf(SignerError);
  });

  it("re-checks the event the extension returns", async () => {
    const local = LocalSigner.fromSecretKey(SECRET_HEX);
    const good = await local.signEvent({ kind: 1, content: "gm" });
    const signer = new Nip07Signer({
      getPublicKey: () => Promise.resolve(PUBKEY),
      signEvent: () => Promise.resolve({ ...good, id: "bogus" }),
    });
    await expect(
      signer.signEvent({ kind: 1, content: "gm" }),
    ).rejects.toBeInstanceOf(SignerError);

    const honest = new Nip07Signer({
      getPublicKey: () => Promise.resolve(PUBKEY),
      signEvent: () => Promise.resolve(good),
    });
    await expect(honest.signEvent({ kind: 1, content: "gm" })).resolves.toEqual(
      good,
    );
  });
});

describe("nip49", () => {
  // logN 4 keeps scrypt fast in tests; production uses the NIP-49 default.
  const LOG_N = 4;

  it("round-trips a secret key through a passphrase", () => {
    const encrypted = encryptSecretKey(SECRET_HEX, "correct horse", LOG_N);
    expect(encrypted).toBeDefined();
    expect(isNcryptsec(encrypted as string)).toBe(true);
    const decrypted = decryptSecretKey(encrypted as string, "correct horse");
    expect(decrypted).toEqual(parseSecretKey(SECRET_HEX));
  });

  it("accepts an nsec as input", () => {
    const encrypted = encryptSecretKey(NSEC, "pw", LOG_N);
    expect(decryptSecretKey(encrypted as string, "pw")).toEqual(
      parseSecretKey(SECRET_HEX),
    );
  });

  it("returns undefined for a wrong passphrase", () => {
    const encrypted = encryptSecretKey(SECRET_HEX, "right", LOG_N);
    expect(decryptSecretKey(encrypted as string, "wrong")).toBeUndefined();
  });

  it("returns undefined for malformed input", () => {
    expect(encryptSecretKey("not a key", "pw", LOG_N)).toBeUndefined();
    expect(decryptSecretKey("", "pw")).toBeUndefined();
    expect(decryptSecretKey(NSEC, "pw")).toBeUndefined();
    expect(decryptSecretKey("ncryptsec1garbage", "pw")).toBeUndefined();
    expect(isNcryptsec(NSEC)).toBe(false);
  });
});
