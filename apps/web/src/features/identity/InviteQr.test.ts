import { describe, expect, it } from "vitest";
import { qrDataUri } from "./InviteQr";

/**
 * Two properties, both of which have a visible failure behind them.
 *
 * The `data:` prefix is the one that would not be noticed in review: an implementation
 * that reached a QR web service instead would work perfectly on a developer's machine
 * while sending a one-time signing secret to a third party on every pairing. Asserting
 * the URI is local is the cheapest way to keep that from being introduced later.
 *
 * The capacity case is a login screen that stops working. QR codes have a hard size
 * limit and the relay list in the invitation form is user-editable, so an oversized
 * URI is reachable without doing anything strange.
 */

const CLIENT_KEY = "a".repeat(64);

describe("qrDataUri", () => {
  it("returns a data: URI, because the CSP allows no other image source", async () => {
    const uri = `nostrconnect://${CLIENT_KEY}?relay=wss://relay.example.com&secret=deadbeefdeadbeef&name=Setu`;
    const data = await qrDataUri(uri);
    expect(data?.startsWith("data:image/")).toBe(true);
  });

  it("gives up quietly when the link is too large for any QR version", async () => {
    // Not throwing is the assertion. The copyable link below the code is a complete
    // way to finish pairing, so an unrenderable code must degrade to "no picture"
    // rather than to an unhandled rejection on the sign-in screen.
    const relays = Array.from(
      { length: 200 },
      (_, i) => `relay=wss://relay-${i}.example.com`,
    ).join("&");
    const huge = `nostrconnect://${CLIENT_KEY}?${relays}&secret=deadbeef`;
    expect(huge.length).toBeGreaterThan(3000);
    await expect(qrDataUri(huge)).resolves.toBeUndefined();
  });
});
