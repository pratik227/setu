import type { NostrEvent } from "@setu/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthorView } from "../notes/types";
import { ModerationQueue } from "./ModerationQueue";
import type { CommunityWrites } from "./useCommunityWrites";

/**
 * Render-level proof of the moderator queue.
 *
 * The behavioural claims worth pinning are all visible only in markup: that the
 * queue exists at all for a moderator, that it offers *approve and nothing else*,
 * and that an unapproved post is rendered as plain text rather than as content
 * whose embeds load.
 */

const AUTHOR = "b".repeat(64);

function post(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "waiting for a moderator",
    sig: "0".repeat(128),
    ...over,
  };
}

const WRITES: CommunityWrites = {
  submitState: { status: "idle" },
  approveState: { status: "idle" },
  canModerate: true,
  submit: async () => true,
  approve: async () => true,
  resetSubmit: () => {},
  resetApprove: () => {},
};

const AUTHORS = new Map<string, AuthorView>([
  [
    AUTHOR,
    { pubkey: AUTHOR, displayName: "Someone", resolved: true } as AuthorView,
  ],
]);

describe("ModerationQueue", () => {
  it("lists a pending post with an approve control", () => {
    const html = renderToStaticMarkup(
      <ModerationQueue posts={[post()]} authors={AUTHORS} writes={WRITES} />,
    );
    expect(html).toContain("Awaiting your approval (1)");
    expect(html).toContain("waiting for a moderator");
    expect(html).toContain("Approve");
    expect(html).toContain("Someone");
  });

  it("offers no reject, and says why", () => {
    // NIP-72 has no rejection event. A Reject button would publish nothing and
    // notify nobody, leaving the moderator believing the author had been told.
    const html = renderToStaticMarkup(
      <ModerationQueue posts={[post()]} authors={AUTHORS} writes={WRITES} />,
    );
    expect(html).not.toContain("Reject");
    expect(html).toContain("There is no reject");
  });

  it("states what approving actually publishes, before it is pressed", () => {
    const html = renderToStaticMarkup(
      <ModerationQueue posts={[post()]} authors={AUTHORS} writes={WRITES} />,
    );
    expect(html).toMatch(/signed, public record/);
  });

  it("renders an unapproved post as text, not as loaded content", () => {
    // A stranger must not be able to put an image on a moderator's screen before
    // anyone admitted it.
    const html = renderToStaticMarkup(
      <ModerationQueue
        posts={[post({ content: "look https://evil.test/tracker.png" })]}
        authors={AUTHORS}
        writes={WRITES}
      />,
    );
    expect(html).toContain("evil.test/tracker.png");
    expect(html).not.toContain("<img");
  });

  it("renders nothing when the queue is empty", () => {
    // No empty-state heading: a moderator with nothing to do should see the
    // community, not a panel telling them so.
    expect(
      renderToStaticMarkup(
        <ModerationQueue posts={[]} authors={AUTHORS} writes={WRITES} />,
      ),
    ).toBe("");
  });

  it("falls back to a truncated npub for an unresolved author", () => {
    const html = renderToStaticMarkup(
      <ModerationQueue posts={[post()]} authors={new Map()} writes={WRITES} />,
    );
    expect(html).toContain("npub1");
  });
});
