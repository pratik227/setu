/**
 * Reacting to and reposting a note, and undoing either.
 *
 * Four properties are load-bearing, and each one exists because the obvious
 * implementation gets it wrong:
 *
 *  1. **Nothing is optimistic.** `usePublish` writes the signed event into the
 *     local store before any relay answers, and `useInteractions` observes the
 *     store — so a count moves through the same path a stranger's reaction takes.
 *     A parallel optimistic counter would be a second source of truth that has to
 *     be reconciled, and reconciliation is where "you reacted" survives a
 *     rejection by every relay.
 *  2. **State is per note id.** A feed has forty rows sharing one hook; a single
 *     `busy` boolean makes every row spin because one of them was clicked.
 *  3. **The store decides whether we already acted, not the view model.** Before
 *     reacting we look for our own prior reaction. `viewerReacted` on a
 *     `NoteView` is a snapshot that can be a second stale, and acting on it is
 *     exactly how a client publishes two reactions to the same note.
 *  4. **Undo is a NIP-09 deletion of our own event, or it does not happen.** If
 *     we cannot find the reaction we are supposedly undoing, we say so. Falling
 *     through to "publish a reaction" — or to a kind-5 aimed at the note itself,
 *     which asks relays to delete someone else's post — are both worse than
 *     doing nothing.
 */

import { type EventTemplate, Kind, type NostrEvent } from "@setu/protocol";
import { useCallback, useRef, useState } from "react";
import { useEngine } from "../../engine/EngineProvider";
import {
  buildDeletion,
  buildReaction,
  buildRepost,
} from "../compose/buildNote";
import type { MiningProgress } from "../compose/pow";
import { usePublish } from "../compose/usePublish";
import { useSession } from "../identity/SessionProvider";

/** Which action a row is running. Undo shares its slot with the action itself. */
export type NoteActionKind =
  | "react"
  | "unreact"
  | "repost"
  | "unrepost"
  | "delete";

/** The control an action belongs to, for spinning the right icon. */
export type NoteActionSlot = "react" | "repost";

export type NoteActionState =
  | { readonly status: "working"; readonly action: NoteActionKind }
  | {
      readonly status: "error";
      readonly action: NoteActionKind;
      readonly message: string;
    };

export interface NoteActionsApi {
  /** In-flight and failed actions, keyed by note id. */
  readonly states: ReadonlyMap<string, NoteActionState>;
  /** Publish a kind-7. Resolves true only when a relay accepted it. */
  react(note: NostrEvent, emoji?: string): Promise<boolean>;
  /** Delete our own prior kind-7 on this note. */
  unreact(note: NostrEvent): Promise<boolean>;
  /** Publish a kind-6/16. Resolves true only when a relay accepted it. */
  repost(note: NostrEvent): Promise<boolean>;
  /** Delete our own prior kind-6/16 of this note. */
  unrepost(note: NostrEvent): Promise<boolean>;
  /**
   * Request deletion of our own note (kind 5). Resolves true when a relay
   * accepted the request — which is not the same as the note being gone.
   */
  deleteNote(note: NostrEvent): Promise<boolean>;
  /** Dismiss a row's error. */
  clear(noteId: string): void;
  /**
   * Proof of work being mined for the action in flight, if any.
   *
   * At most one, because `run` serialises on `inFlight` and one publisher serves
   * every note action. Surfaced so the acting row can say what it is spending
   * ten seconds on instead of showing a bare spinner.
   */
  readonly mining?: MiningProgress | undefined;
  /** Abandon the work and publish without it. No-op when nothing is mining. */
  skipMining(): void;
}

/** Which control the given action drives. */
export function slotOf(action: NoteActionKind): NoteActionSlot {
  return action === "react" || action === "unreact" ? "react" : "repost";
}

const READ_ONLY =
  "This is a read-only session. Unlock or sign in with a key to act on notes.";

export function useNoteActions(): NoteActionsApi {
  const engine = useEngine();
  const { session } = useSession();
  const { publish, state: publishState, skipMining } = usePublish();

  /*
   * Mining progress for whichever action is in flight.
   *
   * There is one publisher behind every note action, so at most one row can be
   * mining at a time — `run` already serialises on `inFlight`. Reading it off the
   * publish state rather than tracking it separately keeps the composer and the
   * row reporting the same numbers from the same source.
   */
  const mining =
    publishState.status === "signing" ? publishState.mining : undefined;
  const [states, setStates] = useState<ReadonlyMap<string, NoteActionState>>(
    new Map(),
  );
  /**
   * Note ids with an action in flight.
   *
   * A ref rather than a read of `states`, so the guard does not make every action
   * callback change identity on every state update — and so two clicks in the
   * same tick see the first one's mark, which a state read cannot promise.
   */
  const inFlight = useRef(new Set<string>());

  const setState = useCallback(
    (noteId: string, state: NoteActionState | undefined) => {
      setStates((previous) => {
        const next = new Map(previous);
        if (state) next.set(noteId, state);
        else next.delete(noteId);
        return next;
      });
    },
    [],
  );

  const clear = useCallback(
    (noteId: string) => setState(noteId, undefined),
    [setState],
  );

  /**
   * Our own events of `kinds` that reference `noteId`.
   *
   * Local only, deliberately. Anything we published went into the store on the
   * way out, so a reaction we cannot find locally is one this account did not
   * make from a client whose events reached this store — and inventing a
   * deletion for an event we never saw would be a guess.
   */
  const ourEventsOn = useCallback(
    async (kinds: readonly number[], noteId: string, pubkey: string) => {
      const rows = await engine.store.query({
        kinds: [...kinds],
        authors: [pubkey],
        "#e": [noteId],
      });
      return rows
        .map((row) => row.event)
        .filter((event) => event.pubkey === pubkey);
    },
    [engine],
  );

  /** A relay we have actually seen this note on, for the repost's `e` hint. */
  const relayHintFor = useCallback(
    async (noteId: string) => {
      const stored = await engine.store.get(noteId);
      return stored?.provenance.relays[0] ?? "";
    },
    [engine],
  );

  /** The shared shape of all four actions: gate, build, publish, report. */
  const run = useCallback(
    async (
      noteId: string,
      action: NoteActionKind,
      build: (
        pubkey: string,
      ) => Promise<
        | { readonly ok: true; readonly template: EventTemplate }
        | { readonly ok: false; readonly message: string }
      >,
    ) => {
      if (!session?.canSign) {
        setState(noteId, { status: "error", action, message: READ_ONLY });
        return false;
      }
      // A second click while the first is in flight is the double-reaction bug in
      // its simplest form. Refuse it silently — the row already shows in-flight.
      if (inFlight.current.has(noteId)) return false;
      inFlight.current.add(noteId);

      setState(noteId, { status: "working", action });

      const fail = (message: string) => {
        setState(noteId, { status: "error", action, message });
        return false;
      };

      try {
        let built: Awaited<ReturnType<typeof build>>;
        try {
          built = await build(session.pubkey);
        } catch (cause) {
          return fail(
            cause instanceof Error
              ? cause.message
              : "Could not read the local store.",
          );
        }
        if (!built.ok) return fail(built.message);

        try {
          const outcome = await publish(built.template);
          if (!outcome.accepted) {
            return fail(
              outcome.results.find((result) => result.message)?.message ??
                "No relay accepted it.",
            );
          }
          // Cleared rather than marked "done": the count arrives through the
          // store observer, so there is nothing left for this row to report.
          setState(noteId, undefined);
          return true;
        } catch (cause) {
          return fail(
            cause instanceof Error ? cause.message : "Signing was declined.",
          );
        }
      } finally {
        inFlight.current.delete(noteId);
      }
    },
    [publish, session, setState],
  );

  const react = useCallback(
    (note: NostrEvent, emoji = "+") =>
      run(note.id, "react", async (pubkey) => {
        const existing = await ourEventsOn([Kind.Reaction], note.id, pubkey);
        // NIP-25 `-` is a downvote, not a like, so it does not count as having
        // already reacted with `+`.
        if (existing.some((event) => event.content !== "-")) {
          return {
            ok: false,
            message: "You have already reacted to this note.",
          };
        }
        return { ok: true, template: buildReaction(note, emoji) };
      }),
    [ourEventsOn, run],
  );

  const unreact = useCallback(
    (note: NostrEvent) =>
      run(note.id, "unreact", async (pubkey) => {
        const mine = (
          await ourEventsOn([Kind.Reaction], note.id, pubkey)
        ).filter((event) => event.content !== "-");
        if (mine.length === 0) {
          return {
            ok: false,
            message:
              "Setu could not find your reaction to this note, so there is nothing to withdraw. It may have been made in another client, or on relays this one has not read.",
          };
        }
        // Every one of them: a duplicate left behind keeps the reaction standing.
        return { ok: true, template: buildDeletion(mine) };
      }),
    [ourEventsOn, run],
  );

  const repost = useCallback(
    (note: NostrEvent) =>
      run(note.id, "repost", async (pubkey) => {
        const existing = await ourEventsOn(
          [Kind.Repost, Kind.GenericRepost],
          note.id,
          pubkey,
        );
        if (existing.length > 0) {
          return { ok: false, message: "You have already reposted this note." };
        }
        return {
          ok: true,
          template: buildRepost(note, await relayHintFor(note.id)),
        };
      }),
    [ourEventsOn, relayHintFor, run],
  );

  const unrepost = useCallback(
    (note: NostrEvent) =>
      run(note.id, "unrepost", async (pubkey) => {
        const mine = await ourEventsOn(
          [Kind.Repost, Kind.GenericRepost],
          note.id,
          pubkey,
        );
        if (mine.length === 0) {
          return {
            ok: false,
            message:
              "Setu could not find your repost of this note, so there is nothing to withdraw. It may have been made in another client, or on relays this one has not read.",
          };
        }
        return { ok: true, template: buildDeletion(mine) };
      }),
    [ourEventsOn, run],
  );

  /**
   * Delete one of your own notes (NIP-09).
   *
   * The author check is here rather than left to the UI, because the request is
   * meaningless otherwise: a kind-5 naming someone else's event asks relays to
   * delete a note you do not own, and a relay that honoured that would be
   * broken. Refusing locally keeps Setu from ever making the request.
   *
   * What deletion means is worth being straight about, and the UI copy says so:
   * a kind-5 is a *request*. Relays that implement NIP-09 will stop serving the
   * note; relays that do not, and anyone who already has a copy, will keep it.
   * "Deleted everywhere" is not a promise any Nostr client can make.
   */
  const deleteNote = useCallback(
    (note: NostrEvent) =>
      run(note.id, "delete", async (pubkey) => {
        if (note.pubkey !== pubkey) {
          return {
            ok: false,
            message: "You can only delete notes published from this account.",
          };
        }
        return { ok: true, template: buildDeletion([note]) };
      }),
    [run],
  );

  return {
    states,
    react,
    unreact,
    repost,
    unrepost,
    deleteNote,
    clear,
    mining,
    skipMining,
  };
}
