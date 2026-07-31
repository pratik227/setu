import { describe, expect, it } from "vitest";
import { hostLabel } from "./useUpload";

/**
 * Naming the upload host without trusting it to parse.
 *
 * The composer prints this mid-upload, and the host is a *synced* setting: it arrives
 * from another device's document as an unvalidated string, so the bare
 * `new URL(host).hostname` this replaced was an unhandled throw during render — with
 * the user's unposted text on screen and their file in flight. It is also called from
 * inside the upload error handler, where throwing would replace "could not reach that
 * server" with a blank screen.
 *
 * So the contract is only: always return something printable, never throw.
 */

describe("hostLabel", () => {
  it("reduces a valid host to its hostname", () => {
    expect(hostLabel("https://media.example")).toBe("media.example");
    expect(hostLabel("https://media.example:8443/upload")).toBe(
      "media.example",
    );
  });

  it.each([
    "",
    "not a url",
    "media.example",
    "https://",
    "://media.example",
    "javascript:alert(1)",
  ])("returns the input unchanged rather than throwing for %o", (host) => {
    expect(() => hostLabel(host)).not.toThrow();
    expect(typeof hostLabel(host)).toBe("string");
  });

  it("never returns undefined for anything a document can carry", () => {
    // The failure this guards is a render crash, so the property worth asserting is
    // total: every string in, a string out.
    for (const host of ["", " ", "\n", "https://a", "wss://a.example"]) {
      expect(hostLabel(host)).toBeTypeOf("string");
    }
  });
});
