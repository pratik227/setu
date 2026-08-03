import { describe, expect, it } from "vitest";
import { computeEventId } from "./event";
import {
  approvalApplies,
  approvedPost,
  buildApproval,
  type Community,
  claimedCommunities,
  communityAddress,
  isModerator,
  newestCommunities,
  parseApproval,
  parseCommunity,
  tagForCommunity,
} from "./nip72";
import { generateSecretKey, getPublicKey, LocalSigner } from "./signers";
import type { Hex32, NostrEvent } from "./types";

/**
 * NIP-72 is a moderation protocol, so the tests are about what must *not* count as
 * moderation: an approval from a stranger, an approval for a different community,
 * and — the sharp one — a moderator's embedded copy that does not match the post
 * they claim to have approved.
 */

const ownerSecret = generateSecretKey();
const OWNER = getPublicKey(ownerSecret) as Hex32;
const modSecret = generateSecretKey();
const MOD = getPublicKey(modSecret) as Hex32;
const authorSecret = generateSecretKey();
const AUTHOR = getPublicKey(authorSecret) as Hex32;
const STRANGER = getPublicKey(generateSecretKey()) as Hex32;

let counter = 0;
function event(over: Partial<NostrEvent>): NostrEvent {
  counter += 1;
  return {
    id: String(counter).padStart(64, "0"),
    pubkey: OWNER,
    created_at: 1_700_000_000 + counter,
    kind: 34550,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...over,
  };
}

function communityEvent(
  tags: readonly (readonly string[])[] = [["d", "gardening"]],
): NostrEvent {
  return event({ tags: tags.map((t) => [...t]) });
}

const COMMUNITY = parseCommunity(
  communityEvent([
    ["d", "gardening"],
    ["name", "Gardening"],
    ["p", MOD, "wss://a.example", "moderator"],
  ]),
) as Community;

/** A real, signed post — so signature checks are exercised, not stubbed. */
async function signedPost(content = "hello"): Promise<NostrEvent> {
  const signer = LocalSigner.fromSecretKey(authorSecret);
  return signer.signEvent({
    kind: 1,
    created_at: 1_700_000_500,
    content,
    tags: [["a", COMMUNITY.address, ""]],
  });
}

async function signedApproval(
  post: NostrEvent,
  by: Uint8Array,
  over: Partial<{ address: string; embedded: NostrEvent }> = {},
): Promise<NostrEvent> {
  const signer = LocalSigner.fromSecretKey(by);
  const template = buildApproval(post, COMMUNITY, 1_700_000_600);
  return signer.signEvent({
    ...template,
    ...(over.address
      ? {
          tags: (template.tags ?? []).map((t) =>
            t[0] === "a" ? ["a", over.address as string, ""] : t,
          ),
        }
      : {}),
    ...(over.embedded ? { content: JSON.stringify(over.embedded) } : {}),
  });
}

describe("parseCommunity", () => {
  it("reads the definition", () => {
    expect(COMMUNITY.name).toBe("Gardening");
    expect(COMMUNITY.identifier).toBe("gardening");
    expect(COMMUNITY.address).toBe(communityAddress(OWNER, "gardening"));
  });

  it("always makes the creator a moderator", () => {
    // Otherwise a community whose author forgot the self-referencing p tag is
    // permanently unmoderatable by the person who created it.
    expect(COMMUNITY.moderators).toContain(OWNER);
    expect(COMMUNITY.moderators).toContain(MOD);
  });

  it("only treats a p tag with the moderator marker as a moderator", () => {
    // A bare p tag is a mention. Granting approval rights to anyone the
    // description referenced would hand moderation to strangers.
    const parsed = parseCommunity(
      communityEvent([
        ["d", "x"],
        ["p", STRANGER, "wss://a.example"],
        ["p", MOD, "wss://a.example", "moderator"],
      ]),
    );
    expect(parsed?.moderators).toContain(MOD);
    expect(parsed?.moderators).not.toContain(STRANGER);
  });

  it("sorts relays by marker", () => {
    const parsed = parseCommunity(
      communityEvent([
        ["d", "x"],
        ["relay", "wss://author.example", "author"],
        ["relay", "wss://req.example", "requests"],
        ["relay", "wss://app.example", "approvals"],
        ["relay", "wss://any.example"],
      ]),
    );
    expect(parsed?.relays.author).toEqual(["wss://author.example"]);
    expect(parsed?.relays.requests).toEqual(["wss://req.example"]);
    expect(parsed?.relays.approvals).toEqual(["wss://app.example"]);
    expect(parsed?.relays.all).toEqual(["wss://any.example"]);
  });

  it("rejects a definition with no d tag, and another kind", () => {
    expect(parseCommunity(communityEvent([["name", "x"]]))).toBeUndefined();
    expect(parseCommunity(event({ kind: 1 }))).toBeUndefined();
  });

  it("falls back to the identifier for a name, and refuses a bad image", () => {
    expect(parseCommunity(communityEvent([["d", "x"]]))?.name).toBe("x");
    for (const bad of ["javascript:alert(1)", "not a url", ""]) {
      expect(
        parseCommunity(
          communityEvent([
            ["d", "x"],
            ["image", bad],
          ]),
        )?.image,
      ).toBeUndefined();
    }
  });
});

describe("newestCommunities", () => {
  it("keeps the newest definition per address", () => {
    const packs = newestCommunities([
      event({
        tags: [
          ["d", "g"],
          ["name", "Old"],
        ],
        created_at: 1000,
      }),
      event({
        tags: [
          ["d", "g"],
          ["name", "New"],
        ],
        created_at: 2000,
      }),
    ]);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe("New");
  });
});

describe("approval verification", () => {
  it("accepts a moderator's approval of a real post", async () => {
    const post = await signedPost();
    const approval = parseApproval(await signedApproval(post, modSecret));
    expect(approval).toBeDefined();
    if (!approval) return;
    expect(approvalApplies(approval, COMMUNITY)).toBe(true);
    expect(approvedPost(approval)?.id).toBe(post.id);
  });

  it("rejects an approval from someone who is not a moderator", async () => {
    // A stranger's opinion is not moderation. Accepting it turns a moderated
    // community into an unmoderated hashtag that still displays a moderator list.
    const post = await signedPost();
    const approval = parseApproval(
      await signedApproval(post, generateSecretKey()),
    );
    expect(approval).toBeDefined();
    expect(approval && approvalApplies(approval, COMMUNITY)).toBe(false);
  });

  it("rejects an approval naming a different community", async () => {
    // Otherwise an approval for community X admits a post into community Y,
    // whose moderators never saw it.
    const post = await signedPost();
    const approval = parseApproval(
      await signedApproval(post, modSecret, {
        address: communityAddress(OWNER, "somewhere-else"),
      }),
    );
    expect(approval && approvalApplies(approval, COMMUNITY)).toBe(false);
  });

  it("prefers the relay's own copy over the moderator's", async () => {
    const post = await signedPost("what the author wrote");
    const approval = parseApproval(await signedApproval(post, modSecret));
    if (!approval) throw new Error("unparsed");
    const resolved = approvedPost(approval, post);
    // Same id, and it is the object that did not pass through the moderator.
    expect(resolved).toBe(post);
  });

  it("refuses a forged embedded copy", async () => {
    // The sharp one. A moderator embeds content the author never wrote, carrying
    // the author's pubkey. Unverified, it renders as a real post by a real person.
    const real = await signedPost("what the author wrote");
    const forged: NostrEvent = { ...real, content: "words put in their mouth" };
    const approval = parseApproval(
      await signedApproval(real, modSecret, { embedded: forged }),
    );
    if (!approval) throw new Error("unparsed");
    // The forgery keeps the real id, so only recomputing the hash catches it.
    expect(computeEventId(forged)).not.toBe(forged.id);
    expect(approvedPost(approval)).toBeUndefined();
  });

  it("refuses an embedded copy whose id is not the approved post", async () => {
    // A moderator approving one post and embedding a different, genuinely signed
    // one — every signature checks out, but it is not the post being approved.
    const approved = await signedPost("approved");
    const other = await signedPost("something else");
    const approval = parseApproval(
      await signedApproval(approved, modSecret, { embedded: other }),
    );
    if (!approval) throw new Error("unparsed");
    expect(approvedPost(approval)).toBeUndefined();
  });

  it("returns undefined when there is no copy and nothing held", async () => {
    const post = await signedPost();
    const signer = LocalSigner.fromSecretKey(modSecret);
    const bare = await signer.signEvent({
      ...buildApproval(post, COMMUNITY, 1_700_000_600),
      content: "",
    });
    const approval = parseApproval(bare);
    expect(approval).toBeDefined();
    // Approved, but unshowable — a different fact from "not approved".
    expect(approval && approvalApplies(approval, COMMUNITY)).toBe(true);
    expect(approval && approvedPost(approval)).toBeUndefined();
  });
});

describe("parseApproval", () => {
  it("requires a community address and a post id", () => {
    expect(parseApproval(event({ kind: 4550, tags: [] }))).toBeUndefined();
    expect(
      parseApproval(event({ kind: 4550, tags: [["a", COMMUNITY.address]] })),
    ).toBeUndefined();
    // An `a` tag for some other addressable kind is not a community approval.
    expect(
      parseApproval(
        event({
          kind: 4550,
          tags: [
            ["a", `30023:${OWNER}:x`],
            ["e", "1".repeat(64)],
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("reads the post's author and kind when given", () => {
    const approval = parseApproval(
      event({
        kind: 4550,
        tags: [
          ["a", COMMUNITY.address],
          ["e", "1".repeat(64)],
          ["p", AUTHOR],
          ["k", "1"],
        ],
      }),
    );
    expect(approval?.postAuthor).toBe(AUTHOR);
    expect(approval?.postKind).toBe(1);
  });
});

describe("isModerator / tagForCommunity / claimedCommunities", () => {
  it("recognises moderators case-insensitively", () => {
    expect(isModerator(COMMUNITY, MOD.toUpperCase())).toBe(true);
    expect(isModerator(COMMUNITY, STRANGER)).toBe(false);
  });

  it("tags a post with the community address", () => {
    const tagged = tagForCommunity(
      { kind: 1, content: "hi", created_at: 1, tags: [["t", "x"]] },
      COMMUNITY,
    );
    expect(tagged.tags ?? []).toContainEqual(["t", "x"]);
    expect(
      (tagged.tags ?? []).some(
        (t) => t[0] === "a" && t[1] === COMMUNITY.address,
      ),
    ).toBe(true);
  });

  it("reads the communities a post claims", () => {
    const post = event({
      kind: 1,
      tags: [
        ["a", COMMUNITY.address],
        ["a", `30023:${OWNER}:article`],
        ["a", COMMUNITY.address],
      ],
    });
    // Deduped, and only community coordinates.
    expect(claimedCommunities(post)).toEqual([COMMUNITY.address]);
  });
});
