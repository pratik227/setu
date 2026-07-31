/**
 * NIP-46 JSON-RPC framing and request/response correlation.
 *
 * ## Every request has a deadline, and that is not defensive coding
 *
 * A remote signer is a program on somebody else's phone. It can be asleep, offline,
 * mid-update, or waiting on a human who has put the phone down — and in all of those
 * cases it neither answers nor errors. Nothing on the wire distinguishes "still
 * thinking" from "will never reply", so a request without a deadline is a promise
 * that never settles: `signEvent` hangs, the compose dialog spins, and the reader is
 * left unable to tell whether their note went out. Same problem and same shape as
 * NIP-45 COUNT against a relay that does not implement it (`core/relay/countRequests.ts`).
 *
 * ## The sender check is a security check
 *
 * A reply is matched on **both** its request id and the pubkey that sent it. Ids are
 * ours, but the inbox is a public relay subscription: anyone can publish a kind-24133
 * event `p`-tagged to our client key. Without the sender check, a stranger who
 * guessed or observed an id could answer on the signer's behalf — and for
 * `get_public_key` that means handing us a different account, after which the whole
 * session is wrong. Matching on the id alone is the mistake this class exists to make
 * impossible.
 *
 * In practice a forged reply also has to survive decryption with the NIP-44
 * conversation key, which an attacker cannot produce. The check stays anyway: it
 * costs one comparison and it does not depend on the caller having decrypted with the
 * right key.
 *
 * ## `auth_url` does not settle anything
 *
 * A signer may answer `result: "auth_url"` with a URL in `error`, meaning "send the
 * human here to approve this". That is progress, not an outcome: the real answer
 * arrives later on the same id. Settling on it would resolve `signEvent` with the
 * string `auth_url` and publish a note with no signature.
 */

import type { Hex32 } from "../../types";
import { SignerError } from "../../types";

/** A request as it appears inside the encrypted payload. */
export interface Nip46Request {
  readonly id: string;
  readonly method: string;
  readonly params: readonly string[];
}

/** A response as it appears inside the encrypted payload. */
export interface Nip46Response {
  readonly id: string;
  readonly result?: string;
  readonly error?: string;
}

/** The `result` value that means "a human must approve this first". */
export const AUTH_URL_RESULT = "auth_url";

/** Default per-request deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * A fresh request id.
 *
 * Random rather than a counter. A counter restarts at 1 every page load, so a reply
 * to request 3 from the previous connection would correlate to request 3 of this one
 * — and a stale `sign_event` result satisfying a different template is a signature
 * over something the user did not compose.
 */
/**
 * The only part of the Web Crypto API this module needs.
 *
 * Structural rather than the DOM `Crypto` type: `@setu/protocol` is typechecked
 * by `apps/cli` under a lib set with no DOM, where `Crypto` does not exist as a
 * type at all. Naming the one method used keeps the package compiling in Node and
 * in the browser, and documents the dependency at the same time.
 */
interface RandomSource {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

export function newRequestId(): string {
  const bytes = new Uint8Array(8);
  const crypto = (globalThis as { crypto?: RandomSource }).crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Serialise a request for the encrypted `content` field. */
export function encodeRequest(request: Nip46Request): string {
  return JSON.stringify({
    id: request.id,
    method: request.method,
    params: [...request.params],
  });
}

/**
 * Read a decrypted payload as a response.
 *
 * Returns `undefined` for anything that is not one, including a *request* — a signer
 * that also acts as a client will send those, and answering a malformed frame with a
 * thrown error would tear down the subscription over one bad event.
 */
export function parseResponse(payload: string): Nip46Response | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return undefined;
  }
  const result =
    typeof candidate.result === "string" ? candidate.result : undefined;
  const error =
    typeof candidate.error === "string" && candidate.error.length > 0
      ? candidate.error
      : undefined;
  // A frame with neither is not an answer to anything.
  if (result === undefined && error === undefined) return undefined;
  return {
    id: candidate.id,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** True when this response is an approval prompt rather than an answer. */
export function isAuthChallenge(response: Nip46Response): boolean {
  return response.result === AUTH_URL_RESULT;
}

interface Waiting {
  readonly method: string;
  readonly from: Hex32;
  readonly resolve: (result: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface PendingOptions {
  /** Called when the signer asks for human approval, with the URL to open. */
  readonly onAuthChallenge?: (url: string, method: string) => void;
}

/**
 * In-flight NIP-46 requests.
 *
 * Split from the signer for the same reason `CountRequests` is split from the relay
 * pool: it shares nothing with the signer's crypto or its method vocabulary, and it
 * is the part whose correctness is worth asserting directly.
 */
export class Nip46Pending {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly options: PendingOptions = {}) {}

  /** How many requests are still waiting. For tests and for `close`. */
  get size(): number {
    return this.waiting.size;
  }

  /**
   * Register a request and hand back the promise for its answer.
   *
   * Resolves with the `result` string, rejects with a `SignerError` on a signer
   * error or on the deadline.
   */
  open(
    id: string,
    method: string,
    from: Hex32,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(
          new SignerError(
            `the remote signer did not answer ${method} within ${Math.round(
              timeoutMs / 1000,
            )}s`,
          ),
        );
      }, timeoutMs);
      this.waiting.set(id, { method, from, resolve, reject, timer });
    });
  }

  /**
   * Route one decrypted response.
   *
   * Ignores anything it cannot attribute — unknown id, or the right id from the
   * wrong sender. Ignoring is correct: a duplicate arrives whenever two relays both
   * deliver the reply, and there is nothing to report about the second copy.
   */
  deliver(from: Hex32, response: Nip46Response): void {
    const entry = this.waiting.get(response.id);
    if (entry === undefined || entry.from !== from) return;

    if (isAuthChallenge(response)) {
      // Left in the map on purpose: the answer to this id is still coming, and the
      // deadline still applies to it. See the module note.
      if (response.error) {
        this.options.onAuthChallenge?.(response.error, entry.method);
      }
      return;
    }

    this.waiting.delete(response.id);
    clearTimeout(entry.timer);
    if (response.result === undefined) {
      entry.reject(
        new SignerError(
          `the remote signer refused ${entry.method}: ${
            response.error ?? "no reason given"
          }`,
        ),
      );
      return;
    }
    entry.resolve(response.result);
  }

  /**
   * Fail one request whose send never left the building.
   *
   * A request is registered before it is published, so that a reply arriving mid-
   * publish is not dropped. The cost of that order is this method: a publish that
   * throws leaves an entry nothing will ever answer, and letting it run to its
   * deadline would report a twenty-second silence for a socket that failed instantly.
   */
  fail(id: string, reason: string): void {
    const entry = this.waiting.get(id);
    if (entry === undefined) return;
    this.waiting.delete(id);
    clearTimeout(entry.timer);
    entry.reject(
      new SignerError(`${entry.method} could not be sent: ${reason}`),
    );
  }

  /** Fail everything still waiting — the connection is gone or being closed. */
  failAll(reason: string): void {
    for (const [id, entry] of this.waiting) {
      this.waiting.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new SignerError(`${entry.method} failed: ${reason}`));
    }
  }
}
