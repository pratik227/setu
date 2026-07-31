/**
 * Saying what the search covered, and what it could not.
 *
 * This file exists because the failure it prevents is the expensive one. Search on
 * Nostr is partial by construction — there is no index of the network, and NIP-50
 * is optional — so an empty result list has at least four causes that look
 * identical on screen: nothing matched, the query never left this device, the only
 * capable relay wants payment first, or the capability check has not finished. Show
 * the same "No results" for all four and the reader concludes the thing they are
 * looking for does not exist, which for three of the four is false.
 *
 * The copy is therefore derived from {@link SearchReach} rather than from whether
 * the list is empty, and it names the reason and the remedy. `countAggregate.ts`
 * makes the same argument about a number that has no answer versus a number that is
 * zero; this is the same distinction one layer up.
 */

import { PaletteFooter, PaletteKey } from "@setu/ui";
import type { RelaySearchState } from "./useRelaySearch";
import { NOTE_SAMPLE, type SearchCorpus } from "./useSearchCorpus";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line naming what this device holds, so the scope is never implied. */
function localScope(corpus: SearchCorpus): string {
  const notes = corpus.noteSampleFull
    ? `the newest ${NOTE_SAMPLE.toLocaleString()} notes`
    : plural(corpus.notes.length, "note");
  return `${plural(corpus.people.length, "profile")} and ${notes} on this device`;
}

/**
 * The relay half of the coverage statement.
 *
 * Every branch names a relay count, because "search is unavailable" without one
 * reads as a broken feature rather than a property of the relays in use — and the
 * remedy (add a relay that implements NIP-50) is only obvious once the reader knows
 * relays are what decides it.
 */
function relayScope(relay: RelaySearchState): string {
  const { routing, reach } = relay;
  const capable = routing.usable.length;
  switch (reach) {
    case "unknown":
      return `checking ${plural(routing.pending.length, "relay")}`;
    case "unavailable":
      return "no relay you use supports search (NIP-50)";
    case "gated":
      return `${plural(capable, "relay")} can search but wants ${
        routing.usable[0]?.gate === "auth-required" ? "sign-in" : "payment"
      } first`;
    default:
      break;
  }
  if (relay.status === "searching") return `asking ${plural(capable, "relay")}`;
  if (relay.status === "failed") return `relay search failed: ${relay.error}`;
  if (relay.status === "done") return `asked ${plural(capable, "relay")}`;
  return `${plural(capable, "relay")} can search`;
}

export function SearchFooter({
  relay,
  corpus,
}: {
  relay: RelaySearchState;
  corpus: SearchCorpus;
}) {
  return (
    <PaletteFooter>
      <span>
        {localScope(corpus)} · {relayScope(relay)}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <PaletteKey>↑</PaletteKey>
        <PaletteKey>↓</PaletteKey>
        <PaletteKey>↵</PaletteKey>
        <PaletteKey>esc</PaletteKey>
      </span>
    </PaletteFooter>
  );
}

/**
 * Why the list is empty, at the length the explanation deserves.
 *
 * Longer than a footer line on purpose. This is the moment the reader decides
 * whether the client is broken, and the difference between "Setu has not fetched
 * that yet" and "that does not exist" cannot be made in four words.
 */
export function EmptySearchReason({
  relay,
  corpus,
}: {
  relay: RelaySearchState;
  corpus: SearchCorpus;
}) {
  const { routing, reach } = relay;
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-sm font-medium">Nothing on this device matches</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
        Setu searched {localScope(corpus)}.{" "}
        {reach === "ready" || reach === "gated" ? null : (
          <>
            {reach === "unknown"
              ? "It is still checking which of your relays can search their own copies."
              : `Relay-side search would widen that, but none of your ${plural(
                  routing.unsupported.length +
                    routing.silent.length +
                    routing.pending.length,
                  "relay",
                )} advertises NIP-50.`}{" "}
          </>
        )}
        {reach === "unavailable" ? (
          <>
            A relay that does not implement it ignores the search term and
            answers with its newest notes instead, so Setu does not ask. Add a
            NIP-50 relay in Settings to search beyond this device.
          </>
        ) : null}
        {reach === "gated" ? (
          <>
            The {plural(routing.usable.length, "relay")} that can search{" "}
            {routing.usable.length === 1 ? "wants" : "want"} payment or a
            sign-in first, so an empty answer from{" "}
            {routing.usable.length === 1 ? "it" : "them"} is expected rather
            than meaningful.
          </>
        ) : null}
      </p>
    </div>
  );
}

/** The palette before anything has been typed. */
export function SearchHelp() {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-xs text-muted-foreground">
        Search a name, a NIP-05 address, or words from a note. Paste an npub,
        note, nevent or nprofile to open it directly.
      </p>
    </div>
  );
}

/**
 * The refusal shown for a pasted `nsec`.
 *
 * Loud, because the reader has just put a private key somewhere it does not
 * belong, and the useful information is not that the search failed — it is that
 * the key may now be in a clipboard, a form-history entry or a screen recording.
 * The key itself is never rendered back; see `parseSearchInput`, which discards it
 * at classification rather than carrying it into an intent.
 */
export function SecretKeyWarning() {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-sm font-medium text-destructive">
        That is a private key
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
        An <code>nsec</code> is the secret that controls an account, so this
        search box will not look it up and has not kept it. If it was not meant
        to be pasted here, treat it as exposed and move the account to a new
        key.
      </p>
    </div>
  );
}
