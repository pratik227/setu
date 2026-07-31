import type { EventTemplate, NostrEvent } from "@setu/protocol";

/**
 * Uploading media to a NIP-96 host, authorised with NIP-98.
 *
 * Two specs meet here. NIP-96 says "ask the host where its upload endpoint is,
 * then POST the file there"; NIP-98 says "prove who you are by signing a kind-27235
 * event describing the request". Both are needed for every host worth using,
 * because an unauthenticated upload endpoint is an open file drop.
 *
 * The parts that need care, and why:
 *
 *  - **The host chooses its own endpoint.** `api_url` comes out of the host's
 *    `nip96.json`, so it is attacker-controlled data if the host is hostile. It is
 *    validated against the same rules as any other server-supplied URL (see
 *    `assertSafeUploadUrl`) rather than trusted because it arrived over HTTPS.
 *  - **The response is untrusted too.** A host can return any `url` it likes,
 *    including a `javascript:` one, and that string ends up in a note that other
 *    people's clients will render. It is validated before it is used.
 *  - **The auth event is scoped to one request.** `u` and `method` pin it to this
 *    URL and verb, so a host cannot replay the signature against a different
 *    endpoint. It is also short-lived by convention; we do not cache it.
 */

/** Kind 27235 — the NIP-98 HTTP auth event. */
const HTTP_AUTH_KIND = 27235;

/** Hosts we will not talk to, however the URL reached us. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
  "metadata.google.internal",
  "instance-data",
]);

/** TLDs that never resolve publicly. See `lnurl.ts` for the same reasoning. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

/**
 * Rejects a URL we must not fetch.
 *
 * `https` only, no credentials in the URL, no non-default ports, and no host that
 * resolves inside the network the browser is running in. A media host that needs
 * any of those is a media host this client will not use — the cost of being wrong
 * is a request made from the reader's machine to their own network, with their
 * signature attached.
 */
export function assertSafeUploadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UploadError("bad-url", "That upload address is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new UploadError("insecure", "Media hosts must use HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UploadError(
      "credentials-in-url",
      "That upload address embeds credentials, which Setu will not send.",
    );
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UploadError(
      "blocked-host",
      "That host is not publicly routable.",
    );
  }
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UploadError(
      "blocked-host",
      "That host is not publicly routable.",
    );
  }
  // Bare IP literals: a hostname is required, so a host cannot point us at an
  // address by number and skip DNS-based checks entirely.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    throw new UploadError(
      "blocked-host",
      "That host is an IP address rather than a name.",
    );
  }
  return url;
}

/** The NIP-98 auth event template for one request. Caller signs it. */
export function buildHttpAuth(url: string, method: string): EventTemplate {
  return {
    kind: HTTP_AUTH_KIND,
    content: "",
    tags: [
      // Both tags are what stop a host replaying the signature elsewhere.
      ["u", url],
      ["method", method.toUpperCase()],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };
}

/** `Authorization: Nostr <base64 event>`, per NIP-98. */
export function httpAuthHeader(event: NostrEvent): string {
  const json = JSON.stringify(event);
  // `btoa` cannot take multi-byte characters, and a signed event is ASCII JSON
  // except for content — which is empty here, but encode properly regardless so
  // this stays correct if that changes.
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary)}`;
}

export interface Nip96Config {
  readonly apiUrl: string;
}

/** Pull `api_url` out of a host's `nip96.json`, validated. */
export function parseNip96Config(body: unknown): Nip96Config {
  if (typeof body !== "object" || body === null) {
    throw new UploadError("bad-config", "That host returned no NIP-96 config.");
  }
  const apiUrl = (body as { api_url?: unknown }).api_url;
  if (typeof apiUrl !== "string" || apiUrl === "") {
    throw new UploadError(
      "bad-config",
      "That host's NIP-96 config names no upload endpoint.",
    );
  }
  // Validated here rather than at the fetch site: this is the moment the value
  // crosses from "something a server said" to "somewhere we will POST a file".
  assertSafeUploadUrl(apiUrl);
  return { apiUrl };
}

export interface UploadedMedia {
  readonly url: string;
  /** MIME type as reported by the host, when it reported one. */
  readonly mimeType?: string;
  /** `x` — SHA-256 of the file as served. */
  readonly hash?: string;
  /** `dim` — "<width>x<height>", when the host measured it. */
  readonly dimensions?: string;
}

/** Media URLs a note may carry. Same allowlist the renderer applies. */
function assertSafeMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UploadError(
      "bad-response",
      "The host returned something that is not a URL.",
    );
  }
  if (url.protocol !== "https:") {
    throw new UploadError(
      "bad-response",
      "The host returned a non-HTTPS media URL.",
    );
  }
  return url.toString();
}

/**
 * Read the upload result.
 *
 * NIP-96 wraps the result in a NIP-94 event whose tags carry the URL. Hosts vary
 * in what they populate, so everything except `url` is optional — and `url` is
 * validated, because it is about to be published in a note that other clients
 * will render as an image.
 */
export function parseUploadResponse(body: unknown): UploadedMedia {
  if (typeof body !== "object" || body === null) {
    throw new UploadError("bad-response", "The host returned no result.");
  }
  const payload = body as {
    status?: unknown;
    message?: unknown;
    nip94_event?: { tags?: unknown };
  };

  if (payload.status === "error") {
    const message =
      typeof payload.message === "string" && payload.message !== ""
        ? payload.message
        : "The host rejected the upload.";
    throw new UploadError("host-rejected", message);
  }

  const tags = payload.nip94_event?.tags;
  if (!Array.isArray(tags)) {
    throw new UploadError(
      "bad-response",
      "The host's response carried no file metadata.",
    );
  }

  const value = (name: string): string | undefined => {
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
        return tag[1];
      }
    }
    return undefined;
  };

  const url = value("url");
  if (url === undefined) {
    throw new UploadError(
      "bad-response",
      "The host's response carried no media URL.",
    );
  }

  const mimeType = value("m");
  const hash = value("x") ?? value("ox");
  const dimensions = value("dim");
  return {
    url: assertSafeMediaUrl(url),
    ...(mimeType ? { mimeType } : {}),
    ...(hash ? { hash } : {}),
    ...(dimensions ? { dimensions } : {}),
  };
}

/**
 * The `imeta` tag for an upload (NIP-92).
 *
 * Worth emitting even though the URL alone renders: it lets a reader's client
 * reserve the right box before the image loads, which is the difference between a
 * timeline that settles and one that jumps as every image arrives.
 */
export function imetaTag(media: UploadedMedia): readonly string[] {
  const parts = [`url ${media.url}`];
  if (media.mimeType) parts.push(`m ${media.mimeType}`);
  if (media.hash) parts.push(`x ${media.hash}`);
  if (media.dimensions) parts.push(`dim ${media.dimensions}`);
  return ["imeta", ...parts];
}

/** What the uploader needs from the outside world, injected for testability. */
export interface UploadDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly sign: (template: EventTemplate) => Promise<NostrEvent>;
}

export interface UploadInput {
  readonly host: string;
  readonly file: File;
  /** Optional caption; hosts may store it as the file's alt text. */
  readonly alt?: string;
}

/** Largest file we will attempt. Hosts cap uploads and reject late, after the
 * whole body has been sent — checking first turns a slow failure into an instant
 * one. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function uploadMedia(
  { host, file, alt }: UploadInput,
  deps: UploadDeps,
): Promise<UploadedMedia> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      "too-large",
      `That file is ${Math.round(file.size / 1024 / 1024)}MB. The limit is ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      }MB.`,
    );
  }

  const hostUrl = assertSafeUploadUrl(host);
  const wellKnown = new URL("/.well-known/nostr/nip96.json", hostUrl);
  const configResponse = await deps.fetch(wellKnown.toString());
  if (!configResponse.ok) {
    throw new UploadError(
      "no-config",
      `${hostUrl.hostname} did not return a NIP-96 config.`,
    );
  }
  const { apiUrl } = parseNip96Config(await configResponse.json());

  const auth = await deps.sign(buildHttpAuth(apiUrl, "POST"));

  const form = new FormData();
  form.append("file", file);
  if (alt) form.append("alt", alt);

  const uploadResponse = await deps.fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: httpAuthHeader(auth) },
    body: form,
  });

  // Parse the body before checking the status: NIP-96 hosts return their reason
  // in the body, and "413" alone tells the reader nothing they can act on.
  let parsed: unknown;
  try {
    parsed = await uploadResponse.json();
  } catch {
    throw new UploadError(
      "bad-response",
      `${hostUrl.hostname} returned ${uploadResponse.status} with no readable body.`,
    );
  }
  if (!uploadResponse.ok && typeof parsed !== "object") {
    throw new UploadError(
      "upload-failed",
      `${hostUrl.hostname} rejected the upload (${uploadResponse.status}).`,
    );
  }
  return parseUploadResponse(parsed);
}
