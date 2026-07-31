/**
 * Minimal hex helpers.
 *
 * Deliberately dependency-free: the crypto packages move their subpath exports
 * between majors, and hex encoding is not worth an import that can break on a
 * dependency bump.
 */

const HEX_RE = /^[0-9a-f]+$/;

/** True if `value` is lowercase hex of exactly `bytes` bytes (2× chars). */
export function isHexOfBytes(value: unknown, bytes: number): boolean {
  return (
    typeof value === "string" &&
    value.length === bytes * 2 &&
    HEX_RE.test(value)
  );
}

/** True if `value` is 32-byte lowercase hex (event id, pubkey). */
export function isHex32(value: unknown): boolean {
  return isHexOfBytes(value, 32);
}

/** True if `value` is 64-byte lowercase hex (schnorr signature). */
export function isHex64(value: unknown): boolean {
  return isHexOfBytes(value, 64);
}

/** Encode bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Decode lowercase-or-uppercase hex to bytes. Returns `undefined` for odd
 * lengths or non-hex input rather than throwing — this sits on parsing paths.
 */
export function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0) return undefined;
  const lower = hex.toLowerCase();
  if (lower.length > 0 && !HEX_RE.test(lower)) return undefined;
  const out = new Uint8Array(lower.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(lower.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
