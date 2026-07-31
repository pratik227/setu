import type { FeedEntry } from "@setu/core";
import type { NostrEvent } from "@setu/protocol";
import { Kind } from "@setu/protocol";
import { ContentHeader, type TabDefinition, TabList } from "@setu/ui";
import { useMemo, useRef, useState } from "react";
import { FeedView } from "../feed/FeedView";
import { noteIdsIn, pubkeysIn, toNoteViews } from "../feed/toNoteViews";
import { useFollows } from "../identity/useFollows";
import { muteFilterNotice } from "../moderation/muteEntries";
import { useMutedFeed } from "../moderation/useMutedFeed";
import type { NoteView } from "../notes/types";
import { useInteractions } from "../notes/useInteractions";
import { useNoteRowActions } from "../notes/useNoteRowActions";
import { useAuthors } from "../profiles/useAuthors";
import { useNotifications } from "./useNotifications";

/**
 * Mentions — every note addressed to the viewer, as a normal timeline.
 *
 * ## Why this is not a `LiveFeed`
 *
 * `FeedDefinition` (`packages/core/src/feed/feedTypes.ts`) narrows by kinds,
 * authors, hashtags and relays. It has no tag-filter field, and widening the core
 * type for one screen is the wrong trade: `#p` is not a feed axis like `#t` is —
 * it is an addressing channel anyone can write to, so a feed engine that accepted
 * it would inherit spam handling it has no business owning. So this screen reads
 * the notification subscription (which already queries `{"#p": [me]}`) and renders
 * the text notes out of it through the *existing* feed view model — `toNoteViews`,
 * `FeedView`, `useNoteRowActions` — rather than a second row implementation.
 *
 * The cost is no `until` pagination here; the notification subscription's limit is
 * the horizon. That is honest for a mentions list, where "everything recent
 * addressed to you" is the whole question.
 *
 * ## The spam judgement
 *
 * A `#p` feed is trivially spammable: tagging a stranger costs nothing, so an
 * unfiltered mentions list is a channel anyone can push into. So a scope control
 * is offered, and it **defaults to "People you follow" once the follow list has
 * actually loaded and is non-empty** — otherwise to "Everyone".
 *
 * The default is on because the failure modes are asymmetric. An unfiltered list
 * that fills with spam is unusable and teaches the reader to stop opening the
 * screen at all; a filtered list that hides a stranger's genuine reply is
 * recoverable in one click, and the hidden count is always stated so the filter is
 * never silent. The conditions on the default matter as much as the default: with
 * `follows.loaded` false we have not fetched the list yet, and filtering by an
 * empty set we merely *have not loaded* shows an empty screen to someone with 500
 * follows — the exact trap `useFollows` documents. A brand-new account that
 * follows nobody gets "Everyone" for the same reason. Once the reader picks a
 * scope, their choice sticks for the session and no longer tracks the list.
 *
 * ## Why the mute list matters more here than anywhere
 *
 * The scope control above handles the *volume* problem and nothing else. It is a
 * blunt instrument — "people you follow" also hides every genuine stranger — and on
 * "Everyone" it does nothing at all. The mute list is the precise instrument for the
 * same channel, and this is the screen where a reader most needs it: a mention is
 * addressed *at them*, so one determined account can put itself at the top of this
 * list indefinitely for the cost of a `p` tag, and no follow-graph heuristic will
 * stop it.
 *
 * So mutes are applied here as well, as a **second, separately counted pass**. Two
 * counts rather than one because the two filters answer different questions and a
 * combined figure would be unactionable: "12 hidden" leaves the reader unable to
 * tell whether switching scope would show them, or whether they muted somebody. It
 * runs above the metadata window for the same reason `LiveFeed` does it there — a
 * muted account that reached the view still took a profile fetch, an interaction
 * slot and a row action entry on the way.
 */

const MENTION_KINDS: readonly number[] = [Kind.ShortTextNote, Kind.Comment];

/** How many rows get author metadata and interaction counts. */
const METADATA_WINDOW = 40;

type Scope = "follows" | "everyone";

const SCOPE_TABS: readonly TabDefinition[] = [
  { id: "follows", label: "People you follow" },
  { id: "everyone", label: "Everyone" },
];

export interface MentionsScreenProps {
  onOpenThread?(id: string): void;
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

export function MentionsScreen({
  onOpenThread,
  onOpenProfile,
  onOpenHashtag,
}: MentionsScreenProps): React.JSX.Element {
  const { events, loading, signedIn, viewerPubkey } = useNotifications();
  const follows = useFollows();

  // `undefined` means "no choice made yet", which is distinct from either scope:
  // it lets the default track the follow list until the reader overrides it, and
  // stop tracking the moment they do.
  const [chosen, setChosen] = useState<Scope | undefined>();
  const suggested: Scope =
    follows.loaded && follows.authors.length > 0 ? "follows" : "everyone";
  const scope = chosen ?? suggested;

  const mountedAt = useRef(Math.floor(Date.now() / 1000));

  const addressed = useMemo(() => {
    if (!viewerPubkey) return [] as NostrEvent[];
    return events.filter(
      (event) =>
        MENTION_KINDS.includes(event.kind) && event.pubkey !== viewerPubkey,
    );
  }, [events, viewerPubkey]);

  const followSet = useMemo(() => new Set(follows.authors), [follows.authors]);

  const shown = useMemo(
    () =>
      scope === "follows"
        ? addressed.filter((event) => followSet.has(event.pubkey))
        : addressed,
    [addressed, scope, followSet],
  );

  const hidden = addressed.length - shown.length;

  const scoped = useMemo<readonly FeedEntry[]>(
    () =>
      shown.map((event) => ({
        key: `note:${event.id}`,
        kind: "note" as const,
        event,
        createdAt: event.created_at,
        reposters: [],
        repostIds: [],
      })),
    [shown],
  );

  // The mute pass, above everything that charges per row. `useMutedFeed` holds the
  // per-row identity cache, so an unchanged row comes back as the same object and
  // the memoisation below survives.
  const muted = useMutedFeed(scoped);
  const entries = muted.entries;

  const resolvable = useMemo(
    () => entries.slice(0, METADATA_WINDOW),
    [entries],
  );
  const pubkeys = useMemo(() => pubkeysIn(resolvable), [resolvable]);
  const noteIds = useMemo(() => noteIdsIn(resolvable), [resolvable]);

  const authors = useAuthors(pubkeys);
  const interactions = useInteractions(noteIds, viewerPubkey);

  // Built from the rows that survived the mute pass, not from `shown`: an event in
  // this map is one the row actions can reply to, react to and report, and a muted
  // account has no row to act from.
  const eventMap = useMemo(() => {
    const map = new Map<string, NostrEvent>();
    for (const entry of entries) map.set(entry.event.id, entry.event);
    return map;
  }, [entries]);
  const { actions, statuses } = useNoteRowActions(eventMap);

  /*
   * The previous result feeds back in so unchanged rows keep their identity.
   * A ref rather than state: it must not itself trigger a render, and it is read
   * during the memo that produces the next value.
   */
  const previous = useRef<readonly NoteView[]>([]);
  const notes = useMemo(() => {
    const next = toNoteViews(
      entries,
      authors,
      interactions,
      mountedAt.current,
      previous.current,
    );
    previous.current = next;
    return next;
  }, [entries, authors, interactions]);

  const emptyCopy = (): { title: string; description: string } => {
    if (!signedIn) {
      return {
        title: "Sign in to see your mentions",
        description:
          "A mention is a note that tags your public key, so there is nothing to fetch until this client knows which key that is.",
      };
    }
    /*
     * The mute list is checked before the scope filter, and that order is the
     * point: a screen that fetched mentions and muted every one of them must not
     * say "nobody has mentioned you". That reads as a broken relay set and sends
     * the reader to settings to fix something that is working exactly as they
     * asked.
     */
    if (muted.hiddenRows > 0 && scoped.length === muted.hiddenRows) {
      return {
        title: "Every mention here is muted",
        description: `${muted.hiddenRows} ${
          muted.hiddenRows === 1 ? "note that mentions" : "notes that mention"
        } you ${muted.hiddenRows === 1 ? "was" : "were"} hidden by your mute list. Nothing is wrong with your relays.`,
      };
    }
    if (scope === "follows" && hidden > 0) {
      return {
        title: "No mentions from people you follow",
        description: `${hidden} ${
          hidden === 1 ? "note mentions" : "notes mention"
        } you from accounts you do not follow. Switch to Everyone to read them.`,
      };
    }
    return {
      title: "Nobody has mentioned you yet",
      description:
        "Notes that tag your key appear here. If this stays empty, the relays in settings may not carry them — this screen shows only what reached this client.",
    };
  };

  const empty = emptyCopy();
  const mutedNotice = muteFilterNotice(muted);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentHeader className="justify-start">
        <TabList
          tabs={SCOPE_TABS}
          value={scope}
          onChange={(id) =>
            setChosen(id === "follows" ? "follows" : "everyone")
          }
          label="Mention scope"
          idPrefix="mentions-scope"
        />
      </ContentHeader>

      {/* The filter is never silent: a reader must be able to tell "nobody
          mentioned me" from "the client is hiding strangers from me". */}
      {scope === "follows" && hidden > 0 ? (
        <p className="setu-feed-column border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
          {hidden} {hidden === 1 ? "mention" : "mentions"} hidden from accounts
          you do not follow.
        </p>
      ) : null}

      <FeedView
        notes={notes}
        actions={actions}
        statuses={statuses}
        loading={loading && notes.length === 0}
        {...(mutedNotice !== undefined ? { mutedNotice } : {})}
        onOpenThread={onOpenThread}
        onOpenProfile={onOpenProfile}
        onOpenHashtag={onOpenHashtag}
        emptyTitle={empty.title}
        emptyDescription={empty.description}
      />
    </div>
  );
}
