import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MiningProgress } from "../compose/pow";
import { NoteActionRow, type NoteRowActions } from "./NoteActionRow";
import type { NoteView } from "./types";

/**
 * Render-level proof that a mining row says what it is doing.
 *
 * `noteRowStatus.test.ts` asserts which row the progress is attached to; this
 * asserts the row actually prints it. The failure being prevented is specific and
 * was real until now: at difficulty 20 a like hashes for about ten seconds behind
 * the ordinary pending spinner, which is indistinguishable from a relay that has
 * stopped answering — so the reader concludes the client is broken rather than
 * that the setting they chose costs this much.
 */

const NOTE: NoteView = {
  id: "a".repeat(64),
  rowKey: `note:${"a".repeat(64)}`,
  kind: 1,
  tags: [],
  createdAt: 1_700_000_000,
  content: "hello",
  author: {
    pubkey: "b".repeat(64),
    displayName: "Someone",
    resolved: true,
  } as NoteView["author"],
  replyCount: 0,
  repostCount: 0,
  reactionCount: 0,
  zapSats: 0,
};

const ACTIONS: NoteRowActions = {
  canSign: true,
  react: () => {},
  repost: () => {},
  bookmark: () => {},
  zap: () => {},
  share: () => {},
  isBookmarked: () => false,
  canDelete: () => false,
  deleteNote: () => {},
  isAuthorMuted: () => false,
  renderMuteDialog: () => null,
  renderReportDialog: () => null,
  renderReplyComposer: () => null,
};

const MINING: MiningProgress = {
  targetBits: 20,
  hashes: 1_400_000,
  elapsedMs: 6_000,
  budgetMs: 21_000,
};

describe("NoteActionRow mining line", () => {
  it("names the difficulty and the work done", () => {
    const html = renderToStaticMarkup(
      <NoteActionRow
        note={NOTE}
        actions={ACTIONS}
        status={{ pending: "react", mining: MINING }}
      />,
    );
    expect(html).toContain("difficulty 20");
    // The elapsed/budget pair is what tells a reader this will end.
    expect(html).toContain("21s");
  });

  it("offers a way out when a skip handler is supplied", () => {
    const html = renderToStaticMarkup(
      <NoteActionRow
        note={NOTE}
        actions={ACTIONS}
        status={{ pending: "react", mining: MINING, onSkipMining: () => {} }}
      />,
    );
    expect(html).toContain("Skip");
  });

  it("renders no mining line on an ordinary pending row", () => {
    // The overwhelmingly common case: difficulty 0, so nothing mines and the row
    // must not grow a line about work that is not happening.
    const html = renderToStaticMarkup(
      <NoteActionRow
        note={NOTE}
        actions={ACTIONS}
        status={{ pending: "react" }}
      />,
    );
    expect(html).not.toContain("difficulty");
    expect(html).not.toContain("Skip");
  });
});
