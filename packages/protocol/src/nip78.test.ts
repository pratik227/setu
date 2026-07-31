import { describe, expect, it } from "vitest";
import {
  APP_DATA_KIND,
  AppDataError,
  appDataFilter,
  appDataTemplate,
  decryptAppData,
  encryptAppData,
  isAppData,
  looksLikePlaintextJson,
  parseAppDataJson,
  replacesAppData,
  serializeAppDataJson,
} from "./nip78";
import { LocalSigner } from "./signers/local";
import type { NostrEvent } from "./types";

const IDENTIFIER = "setu/settings";

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_700_000_000,
    kind: APP_DATA_KIND,
    tags: [["d", IDENTIFIER]],
    content: "",
    sig: "c".repeat(128),
    ...overrides,
  };
}

describe("appDataFilter", () => {
  it("scopes to one account, one kind and one document", () => {
    const filter = appDataFilter("b".repeat(64), IDENTIFIER, 4);
    expect(filter).toEqual({
      kinds: [APP_DATA_KIND],
      authors: ["b".repeat(64)],
      "#d": [IDENTIFIER],
      limit: 4,
    });
  });

  // Without the `#d`, the filter asks for *every* app's data for this account —
  // other clients' documents, which we neither need nor can read.
  it("always carries the d filter", () => {
    expect(appDataFilter("b".repeat(64), "other/app", 1)["#d"]).toEqual([
      "other/app",
    ]);
  });
});

describe("isAppData", () => {
  it("accepts our document", () => {
    expect(isAppData(event(), IDENTIFIER)).toBe(true);
  });

  it("rejects another application's document at the same kind", () => {
    expect(isAppData(event({ tags: [["d", "other/app"]] }), IDENTIFIER)).toBe(
      false,
    );
  });

  it("rejects the right d tag on the wrong kind", () => {
    expect(isAppData(event({ kind: 30000 }), IDENTIFIER)).toBe(false);
  });
});

describe("replacesAppData", () => {
  it("treats anything as newer than nothing", () => {
    expect(replacesAppData(event(), undefined)).toBe(true);
  });

  it("prefers the later created_at", () => {
    const older = event({ created_at: 100, id: "0".repeat(64) });
    const newer = event({ created_at: 200, id: "f".repeat(64) });
    expect(replacesAppData(newer, older)).toBe(true);
    expect(replacesAppData(older, newer)).toBe(false);
  });

  // NIP-01's tie-break, reproduced exactly. Getting it backwards means believing
  // we hold the current document while relays serve the other one, and the next
  // write is then built from a copy that no longer exists anywhere.
  it("breaks a created_at tie on the lowest id", () => {
    const low = event({ created_at: 100, id: `0${"a".repeat(63)}` });
    const high = event({ created_at: 100, id: `f${"a".repeat(63)}` });
    expect(replacesAppData(low, high)).toBe(true);
    expect(replacesAppData(high, low)).toBe(false);
  });

  it("does not replace itself", () => {
    const only = event();
    expect(replacesAppData(only, only)).toBe(false);
  });
});

describe("appDataTemplate", () => {
  it("writes the d tag", () => {
    const template = appDataTemplate({ identifier: IDENTIFIER, content: "x" });
    expect(template.kind).toBe(APP_DATA_KIND);
    expect(template.tags).toEqual([["d", IDENTIFIER]]);
  });

  // A tag this build does not understand belongs to something else. Dropping it
  // on save is the same silent deletion as dropping an unknown content key.
  it("preserves tags it does not understand and never duplicates d", () => {
    const previous = event({
      tags: [
        ["d", IDENTIFIER],
        ["alt", "client settings"],
        ["expiration", "1900000000"],
      ],
    });
    const template = appDataTemplate({
      identifier: IDENTIFIER,
      content: "x",
      previous,
    });
    expect(template.tags).toEqual([
      ["d", IDENTIFIER],
      ["alt", "client settings"],
      ["expiration", "1900000000"],
    ]);
  });
});

describe("parseAppDataJson", () => {
  it("splits the version from the fields", () => {
    expect(parseAppDataJson('{"v":2,"themeId":"dusk"}')).toEqual({
      version: 2,
      fields: { themeId: "dusk" },
    });
  });

  it("keeps keys it has never heard of", () => {
    const parsed = parseAppDataJson('{"v":1,"futureThing":{"nested":true}}');
    expect(parsed?.fields).toEqual({ futureThing: { nested: true } });
  });

  // A document with no version is not assumed to be version 1: we would be
  // guessing at what its keys mean, and a wrong guess writes a plausible-looking
  // document over a real one.
  it.each([
    "{}",
    '{"themeId":"dusk"}',
    '{"v":"1"}',
    '{"v":1.5}',
    '{"v":0}',
    '{"v":-1}',
    "[]",
    '"string"',
    "null",
    "not json",
    "",
  ])("refuses %o", (raw) => {
    expect(parseAppDataJson(raw)).toBeUndefined();
  });
});

describe("serializeAppDataJson", () => {
  it("round-trips through the parser", () => {
    const fields = { themeId: "dusk", unknownKey: [1, 2, 3] };
    const parsed = parseAppDataJson(serializeAppDataJson(3, fields));
    expect(parsed).toEqual({ version: 3, fields });
  });

  it("puts the version first and ignores a version smuggled into the fields", () => {
    const json = serializeAppDataJson(1, { v: 99, themeId: "dusk" });
    expect(json).toBe('{"v":1,"themeId":"dusk"}');
  });
});

describe("looksLikePlaintextJson", () => {
  it("recognises a bare object", () => {
    expect(looksLikePlaintextJson('  {"v":1}')).toBe(true);
  });

  // Every NIP-44 v2 payload is base64 of a leading 0x02 byte, so it starts "A".
  it("does not mistake a nip44 payload for plaintext", () => {
    expect(looksLikePlaintextJson("AgtZ+3xk...")).toBe(false);
  });
});

describe("encryptAppData / decryptAppData", () => {
  const signer = LocalSigner.fromSecretKey("11".repeat(32));

  it("round-trips a document through self-encryption", async () => {
    const pubkey = await signer.pubkey();
    const body = serializeAppDataJson(1, { themeId: "dusk" });
    const content = await encryptAppData(signer, body);
    expect(content).not.toContain("dusk");
    const decrypted = await decryptAppData(signer, event({ pubkey, content }));
    expect(decrypted).toBe(body);
  });

  // A plaintext document is still readable, so a build that once wrote one is not
  // reported as corrupt. Setu never writes one.
  it("reads a plaintext document without a decrypter", async () => {
    const content = '{"v":1,"themeId":"dusk"}';
    await expect(decryptAppData({}, event({ content }))).resolves.toBe(content);
  });

  // "Your extension cannot encrypt this" and "you have no settings stored" are
  // different facts, and reporting the second when the first is true invites the
  // user to overwrite a document they could not read.
  it("reports a signer without nip44 as its own case", async () => {
    const bare = { pubkey: () => Promise.resolve("b".repeat(64)) };
    await expect(encryptAppData(bare, "{}")).rejects.toMatchObject({
      code: "no-nip44",
    });
    await expect(
      decryptAppData({}, event({ content: "Agtnotplaintext" })),
    ).rejects.toMatchObject({ code: "no-nip44" });
  });

  it("reports an undecryptable document distinctly from a missing one", async () => {
    const pubkey = await signer.pubkey();
    const failure = await decryptAppData(
      signer,
      event({ pubkey, content: "Agtgarbage" }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppDataError);
    expect((failure as AppDataError).code).toBe("undecryptable");
  });

  it("cannot be decrypted by another key", async () => {
    const other = LocalSigner.fromSecretKey("22".repeat(32));
    const pubkey = await signer.pubkey();
    const content = await encryptAppData(signer, '{"v":1}');
    await expect(
      decryptAppData(other, event({ pubkey, content })),
    ).rejects.toMatchObject({ code: "undecryptable" });
  });
});
