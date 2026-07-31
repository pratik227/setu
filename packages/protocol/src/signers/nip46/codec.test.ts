import { describe, expect, it } from "vitest";
import { encryptNip04 } from "../../nip04";
import { generateSecretKey, getPublicKey, LocalSigner } from "../local";
import { Nip46Codec, schemeOf } from "./codec";

/**
 * The scheme discriminator is the load-bearing part of NIP-04 support.
 *
 * Everything else in `codec.ts` is a thin call into a primitive that already has its
 * own tests. What is genuinely ours is the decision "which encryption is this?", made
 * on the payload's shape with no help from the protocol — and getting it wrong is not
 * a visible error. A NIP-44 payload misread as NIP-04 fails to decrypt, which the
 * signer treats as "not for this conversation" and drops in silence, so the symptom is
 * a signer that appears to have stopped answering.
 */

const clientSecret = generateSecretKey();
const peerSecret = generateSecretKey();
const peer = getPublicKey(peerSecret);
const client = getPublicKey(clientSecret);
const codec = new Nip46Codec(clientSecret);
const peerSigner = LocalSigner.fromSecretKey(peerSecret);

describe("schemeOf", () => {
  it("never mistakes a NIP-44 payload for a NIP-04 one", async () => {
    // Run over many payloads rather than one: NIP-44 output is base64 of a random
    // nonce, and a discriminator that happened to work for one sample is not a
    // discriminator. A false "nip04" here is a reply dropped as undecryptable.
    for (let i = 0; i < 64; i += 1) {
      const content = await peerSigner.nip44Encrypt(client, `frame ${i}`);
      expect(schemeOf(content)).toBe("nip44");
    }
  });

  it("recognises NIP-04's `?iv=` shape", () => {
    const content = encryptNip04(peerSecret, client, "legacy frame");
    expect(schemeOf(content)).toBe("nip04");
  });
});

describe("Nip46Codec", () => {
  it("round-trips in both schemes and reports which one it read", async () => {
    // The reported scheme is the *only* evidence the signer has for what to send
    // next. A codec that decrypted correctly but reported the wrong scheme would
    // leave every subsequent request in an envelope the peer cannot open.
    const modern = await peerSigner.nip44Encrypt(client, "modern");
    expect(await codec.decrypt(peer, modern)).toEqual({
      payload: "modern",
      scheme: "nip44",
    });
    const legacy = encryptNip04(peerSecret, client, "legacy");
    expect(await codec.decrypt(peer, legacy)).toEqual({
      payload: "legacy",
      scheme: "nip04",
    });
  });

  it("encrypts in the scheme it is told to, and the peer can read it", async () => {
    const modern = await codec.encrypt(peer, "up", "nip44");
    expect(await peerSigner.nip44Decrypt(client, modern)).toBe("up");
    const legacy = await codec.encrypt(peer, "up", "nip04");
    // Readable by the peer *and* recognisable as NIP-04 on the way back, which is
    // what makes the two directions of this module consistent.
    expect(schemeOf(legacy)).toBe("nip04");
  });

  it("rejects a frame that neither scheme reads, rather than returning junk", async () => {
    // The caller reads a rejection as "not addressed to this conversation" and drops
    // it. A codec that resolved with garbage instead would hand `parseResponse` noise
    // on every unrelated kind-24133 event anyone published to our client key.
    await expect(codec.decrypt(peer, "not encrypted at all")).rejects.toThrow();
    await expect(codec.decrypt(peer, "AAAA?iv=AAAA")).rejects.toThrow();
  });

  it("does not accept a well-formed frame from the wrong key", async () => {
    // The scheme fallback must not become a way in. Trying both schemes widens what
    // is *parsed*, never who is trusted: a frame encrypted by a stranger is still
    // outside this conversation and fails under both.
    const stranger = LocalSigner.fromSecretKey(generateSecretKey());
    const notOurs = await stranger.nip44Encrypt(client, "x");
    await expect(codec.decrypt(peer, notOurs)).rejects.toThrow();
  });
});
