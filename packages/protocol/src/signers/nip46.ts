/**
 * NIP-46 (remote "bunker" signer) — not implemented yet.
 *
 * This file exists to record the design constraint rather than the code: the
 * `NostrSigner` contract is already fully async, including `pubkey()`, so a
 * bunker implementation drops in behind it without touching any call site. That
 * is the whole reason the contract has no sync escape hatch.
 *
 * When implemented, it belongs here and needs: relay transport for kind-24133
 * request/response, NIP-44 encrypted payloads, per-request timeouts, and a
 * connection token parser for `bunker://` URIs.
 */

/** Marker for the unimplemented remote-signer backend. */
export const NIP46_STATUS = "not-implemented" as const;
