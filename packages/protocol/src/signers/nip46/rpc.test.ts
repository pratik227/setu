import { describe, expect, it, vi } from "vitest";
import {
  encodeRequest,
  isAuthChallenge,
  Nip46Pending,
  newRequestId,
  parseResponse,
} from "./rpc";

const SIGNER =
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const IMPOSTOR =
  "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075";

describe("encodeRequest", () => {
  it("emits the three JSON-RPC fields with params as an array", () => {
    expect(
      JSON.parse(
        encodeRequest({ id: "a1", method: "sign_event", params: ["{}"] }),
      ),
    ).toEqual({ id: "a1", method: "sign_event", params: ["{}"] });
  });
});

describe("parseResponse", () => {
  it("reads a result and an error", () => {
    expect(parseResponse('{"id":"a1","result":"pong"}')).toEqual({
      id: "a1",
      result: "pong",
    });
    expect(parseResponse('{"id":"a1","result":"","error":"denied"}')).toEqual({
      id: "a1",
      result: "",
      error: "denied",
    });
  });

  it("returns undefined for anything that is not a response", () => {
    // A signer is a NIP-46 peer too and may send us *requests*. Throwing on one
    // would tear the subscription down over a frame we simply do not service.
    expect(parseResponse("not json")).toBeUndefined();
    expect(
      parseResponse('{"id":"a1","method":"connect","params":[]}'),
    ).toBeUndefined();
    expect(parseResponse('{"result":"pong"}')).toBeUndefined();
    expect(parseResponse('{"id":"","result":"pong"}')).toBeUndefined();
    expect(parseResponse("[]")).toBeUndefined();
  });
});

describe("newRequestId", () => {
  it("is random rather than sequential", () => {
    // A counter restarts at 1 on every reload, so a late reply to request 3 of a
    // previous connection would satisfy request 3 of this one.
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    expect(newRequestId()).not.toBe("1");
  });
});

describe("Nip46Pending", () => {
  it("resolves the matching request with its result", async () => {
    const pending = new Nip46Pending();
    const answer = pending.open("a1", "ping", SIGNER, 1000);
    pending.deliver(SIGNER, { id: "a1", result: "pong" });
    await expect(answer).resolves.toBe("pong");
    expect(pending.size).toBe(0);
  });

  it("ignores a reply from a pubkey we did not ask", async () => {
    // The inbox is a public relay subscription: anyone can address a kind-24133 to
    // our client key. Matching on the id alone would let a stranger answer
    // `get_public_key` and hand us somebody else's account.
    const pending = new Nip46Pending();
    const answer = pending.open("a1", "get_public_key", SIGNER, 40);
    pending.deliver(IMPOSTOR, { id: "a1", result: IMPOSTOR });
    expect(pending.size).toBe(1);
    await expect(answer).rejects.toThrow(/did not answer get_public_key/);
  });

  it("ignores an unknown id and a duplicate delivery", async () => {
    const pending = new Nip46Pending();
    const answer = pending.open("a1", "ping", SIGNER, 1000);
    pending.deliver(SIGNER, { id: "other", result: "pong" });
    pending.deliver(SIGNER, { id: "a1", result: "pong" });
    // Two relays delivering the same reply is routine; the second copy is nothing
    // to report.
    pending.deliver(SIGNER, { id: "a1", result: "different" });
    await expect(answer).resolves.toBe("pong");
  });

  it("rejects on a deadline, because silence is the normal failure", async () => {
    const pending = new Nip46Pending();
    await expect(pending.open("a1", "sign_event", SIGNER, 10)).rejects.toThrow(
      /did not answer sign_event/,
    );
    expect(pending.size).toBe(0);
  });

  it("rejects with the signer's reason when it refuses", async () => {
    const pending = new Nip46Pending();
    const answer = pending.open("a1", "sign_event", SIGNER, 1000);
    pending.deliver(SIGNER, { id: "a1", error: "user rejected" });
    await expect(answer).rejects.toThrow(/refused sign_event: user rejected/);
  });

  it("keeps waiting through an auth_url, and reports the URL", async () => {
    // `auth_url` is progress, not an outcome. Settling on it would resolve
    // `signEvent` with the string "auth_url" and publish an unsigned note.
    const onAuthChallenge = vi.fn();
    const pending = new Nip46Pending({ onAuthChallenge });
    const answer = pending.open("a1", "sign_event", SIGNER, 1000);
    pending.deliver(SIGNER, {
      id: "a1",
      result: "auth_url",
      error: "https://bunker.example/approve?x=1",
    });
    expect(onAuthChallenge).toHaveBeenCalledWith(
      "https://bunker.example/approve?x=1",
      "sign_event",
    );
    expect(pending.size).toBe(1);
    pending.deliver(SIGNER, { id: "a1", result: "{}" });
    await expect(answer).resolves.toBe("{}");
  });

  it("fails one request whose send never left", async () => {
    const pending = new Nip46Pending();
    const answer = pending.open("a1", "ping", SIGNER, 60_000);
    pending.fail("a1", "no relay accepted it");
    await expect(answer).rejects.toThrow(
      /ping could not be sent: no relay accepted it/,
    );
    expect(pending.size).toBe(0);
  });

  it("fails everything on close instead of leaving promises hanging", async () => {
    const pending = new Nip46Pending();
    const a = pending.open("a1", "ping", SIGNER, 60_000);
    const b = pending.open("a2", "sign_event", SIGNER, 60_000);
    pending.failAll("connection closed");
    await expect(a).rejects.toThrow(/connection closed/);
    await expect(b).rejects.toThrow(/connection closed/);
    expect(pending.size).toBe(0);
  });
});

describe("isAuthChallenge", () => {
  it("keys off the result, not the presence of an error", () => {
    expect(isAuthChallenge({ id: "a", result: "auth_url" })).toBe(true);
    expect(isAuthChallenge({ id: "a", error: "https://x.example" })).toBe(
      false,
    );
  });
});
