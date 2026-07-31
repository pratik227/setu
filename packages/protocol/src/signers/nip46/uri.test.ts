import { describe, expect, it } from "vitest";
import { encodeNpub } from "../../nip19";
import {
  buildNostrConnectUri,
  isBunkerUri,
  parseBunkerUri,
  parseNostrConnectUri,
  redactBunkerUri,
} from "./uri";

const SIGNER_PUBKEY =
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const CLIENT_PUBKEY =
  "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075";
const RELAY = "wss://relay.example.com";

describe("parseBunkerUri", () => {
  it("reads the signer pubkey, every relay, and the secret", () => {
    const uri = `bunker://${SIGNER_PUBKEY}?relay=${encodeURIComponent(
      RELAY,
    )}&relay=${encodeURIComponent("wss://two.example")}&secret=s3cr3t`;
    expect(parseBunkerUri(uri)).toEqual({
      remoteSignerPubkey: SIGNER_PUBKEY,
      relays: [RELAY, "wss://two.example"],
      secret: "s3cr3t",
    });
  });

  it("accepts an npub authority", () => {
    const npub = encodeNpub(SIGNER_PUBKEY);
    expect(
      parseBunkerUri(`bunker://${npub}?relay=${encodeURIComponent(RELAY)}`)
        ?.remoteSignerPubkey,
    ).toBe(SIGNER_PUBKEY);
  });

  it("tolerates a trailing slash and surrounding whitespace", () => {
    expect(
      parseBunkerUri(
        `  bunker://${SIGNER_PUBKEY}/?relay=${encodeURIComponent(RELAY)}  `,
      )?.relays,
    ).toEqual([RELAY]);
  });

  it("collapses a relay named twice", () => {
    // Two copies would double every request and every reply for no benefit.
    const uri = `bunker://${SIGNER_PUBKEY}?relay=${encodeURIComponent(
      RELAY,
    )}&relay=${encodeURIComponent(RELAY)}`;
    expect(parseBunkerUri(uri)?.relays).toEqual([RELAY]);
  });

  it("drops a relay hint that is not a websocket URL", () => {
    // An https hint cannot be opened, and a connection to nowhere is
    // indistinguishable from a signer that never answered.
    const uri = `bunker://${SIGNER_PUBKEY}?relay=${encodeURIComponent(
      "https://relay.example.com",
    )}&relay=${encodeURIComponent(RELAY)}`;
    expect(parseBunkerUri(uri)?.relays).toEqual([RELAY]);
  });

  it("refuses a URI with no usable relay", () => {
    expect(parseBunkerUri(`bunker://${SIGNER_PUBKEY}`)).toBeUndefined();
    expect(
      parseBunkerUri(`bunker://${SIGNER_PUBKEY}?relay=http://nope.example`),
    ).toBeUndefined();
  });

  it("refuses an authority that is not a key, without throwing", () => {
    // This runs per keystroke on the login form: partial input is the normal state.
    expect(parseBunkerUri("bunker://")).toBeUndefined();
    expect(
      parseBunkerUri("bunker://not-a-key?relay=wss://a.example"),
    ).toBeUndefined();
    expect(parseBunkerUri("bunker://abc")).toBeUndefined();
  });

  it("is not fooled by another scheme", () => {
    expect(
      parseBunkerUri(`nostrconnect://${SIGNER_PUBKEY}?relay=${RELAY}`),
    ).toBeUndefined();
    expect(isBunkerUri("BUNKER://x")).toBe(true);
    expect(isBunkerUri("nostrconnect://x")).toBe(false);
  });

  it("omits the secret key entirely when there is none", () => {
    const parsed = parseBunkerUri(
      `bunker://${SIGNER_PUBKEY}?relay=${encodeURIComponent(RELAY)}`,
    );
    expect(parsed).toBeDefined();
    expect("secret" in (parsed ?? {})).toBe(false);
  });
});

describe("redactBunkerUri", () => {
  it("removes the secret so the URI can appear in an error", () => {
    const redacted = redactBunkerUri(
      `bunker://${SIGNER_PUBKEY}?relay=${encodeURIComponent(
        RELAY,
      )}&secret=s3cr3t`,
    );
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).toContain("secret=removed");
    expect(redacted).toContain(SIGNER_PUBKEY);
  });

  it("returns an unparseable string unchanged, so the typo stays visible", () => {
    expect(redactBunkerUri("  bunker://oops ")).toBe("bunker://oops");
  });
});

describe("nostrconnect round trip", () => {
  it("survives being built and read back", () => {
    // A URI we cannot read back is one no signer will read either, and that shows
    // up only as a handshake that silently never completes.
    const uri = buildNostrConnectUri({
      clientPubkey: CLIENT_PUBKEY,
      relays: [RELAY, "wss://two.example"],
      secret: "abc123",
      name: "Setu",
      url: "https://setu.example",
      perms: ["sign_event", "nip44_decrypt"],
    });
    expect(uri.startsWith(`nostrconnect://${CLIENT_PUBKEY}?`)).toBe(true);
    expect(parseNostrConnectUri(uri)).toEqual({
      clientPubkey: CLIENT_PUBKEY,
      relays: [RELAY, "wss://two.example"],
      secret: "abc123",
      perms: ["sign_event", "nip44_decrypt"],
      name: "Setu",
      url: "https://setu.example",
    });
  });

  it("percent-encodes relay URLs rather than joining them", () => {
    // One `relay=` per relay: a comma-joined list is silently one relay nothing
    // can open.
    const uri = buildNostrConnectUri({
      clientPubkey: CLIENT_PUBKEY,
      relays: [RELAY, "wss://two.example"],
      secret: "abc123",
    });
    expect(uri.match(/relay=/g)).toHaveLength(2);
  });

  it("refuses a URI with no secret, because the secret is the authentication", () => {
    expect(
      parseNostrConnectUri(
        `nostrconnect://${CLIENT_PUBKEY}?relay=${encodeURIComponent(RELAY)}`,
      ),
    ).toBeUndefined();
  });
});
