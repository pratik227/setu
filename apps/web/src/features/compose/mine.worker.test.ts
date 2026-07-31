import { computeEventId, eventDifficulty } from "@setu/protocol";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PowMineRequest, PowWorkerMessage } from "./pow";

/**
 * The worker's message contract, exercised without a browser.
 *
 * A worker cannot be mounted in a Node test, but its contract can: it listens for
 * one request and it must always answer. That is the part worth pinning, because
 * every way of getting it wrong looks the same from the composer — a Post button
 * that spins forever, with no error anywhere. Termination and the watchdog live in
 * `usePow`, where a real `Worker` is involved.
 */

const posted: PowWorkerMessage[] = [];
let deliver: (message: { data: PowMineRequest }) => void;

beforeAll(async () => {
  const scope = globalThis as unknown as {
    addEventListener(type: string, listener: unknown): void;
    postMessage(message: PowWorkerMessage): void;
  };
  scope.addEventListener = (type: string, listener: unknown) => {
    if (type === "message") {
      deliver = listener as (message: { data: PowMineRequest }) => void;
    }
  };
  scope.postMessage = (message: PowWorkerMessage) => {
    posted.push(message);
  };
  // Imported after the globals are in place, because the module registers its
  // listener at import time — which is what a real worker does on startup.
  await import("./mine.worker");
});

beforeEach(() => {
  posted.length = 0;
});

const EVENT = {
  pubkey: "a".repeat(64),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [["t", "nostr"]],
  content: "hello",
};

describe("mine.worker", () => {
  it("answers with a mined event whose id really has the zeros", () => {
    deliver({ data: { event: EVENT, targetBits: 8, budgetMs: 30_000 } });

    const last = posted.at(-1);
    expect(last?.type).toBe("mined");
    if (last?.type !== "mined") return;

    // Recomputed here rather than trusted: the composer reports this number to the
    // user, so a miner that mis-counted would have it advertising work the event
    // does not carry — which is the false claim NIP-13 says invalidates an event.
    expect(eventDifficulty(computeEventId(last.event))).toBe(last.difficulty);
    expect(last.difficulty).toBeGreaterThanOrEqual(8);

    const nonce = last.event.tags.find((tag) => tag[0] === "nonce");
    expect(nonce?.[2]).toBe("8");
    // The rest of the event is untouched: a miner that dropped a tag or re-dated the
    // note would be publishing something other than what was written.
    expect(last.event.tags).toContainEqual(["t", "nostr"]);
    expect(last.event.created_at).toBe(1_700_000_000);
  });

  /*
   * Timing out is a normal completion and must still produce a message. A worker
   * that simply stopped talking here would leave `publish` awaiting a promise that
   * never settles — the note is never signed, never published, and the composer
   * spins until the tab is closed.
   */
  it("answers timeout rather than going quiet", () => {
    deliver({ data: { event: EVENT, targetBits: 240, budgetMs: 300 } });
    expect(posted.at(-1)?.type).toBe("timeout");
  });

  // Progress is the only thing distinguishing a long mine from a hung tab, and it
  // has to escape a loop that never yields — through the injected clock.
  it("reports progress while the loop is still running", () => {
    deliver({ data: { event: EVENT, targetBits: 240, budgetMs: 600 } });

    const progress = posted.filter((message) => message.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    const first = progress[0];
    if (first?.type !== "progress") return;
    expect(first.hashes).toBeGreaterThan(0);
    expect(first.elapsedMs).toBeGreaterThan(0);
  });
});
