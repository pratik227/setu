import {
  PaletteDialog,
  PaletteField,
  PaletteGroup,
  PaletteList,
  Spinner,
} from "@setu/ui";
import { Search } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AuthorView } from "../notes/types";
import { useAuthors } from "../profiles/useAuthors";
import {
  EmptySearchReason,
  SearchFooter,
  SearchHelp,
  SecretKeyWarning,
} from "./SearchCoverage";
import { GROUP_LABELS, SearchNotice, SearchResultRow } from "./SearchRows";
import { buildSearchItems, groupItems, type SearchItem } from "./searchItems";
import { parseSearchInput } from "./searchQuery";
import { useRelaySearch } from "./useRelaySearch";
import { useSearchCorpus } from "./useSearchCorpus";

const NO_TERMS: readonly string[] = [];

/**
 * Attach profiles that arrived after the corpus snapshot was taken.
 *
 * A projection over the built items rather than a rebuild: re-running the ranking
 * whenever a batch of avatars lands would re-sort the list under the reader's
 * cursor for a change that cannot affect the ordering, since author names are not
 * part of a note's score.
 */
function withLateAuthors(
  items: readonly SearchItem[],
  authors: ReadonlyMap<string, AuthorView>,
): readonly SearchItem[] {
  if (authors.size === 0) return items;
  let changed = false;
  const out = items.map((item) => {
    if (item.kind !== "note" || item.author !== undefined) return item;
    const author = authors.get(item.note.pubkey);
    if (author === undefined) return item;
    changed = true;
    return {
      ...item,
      author: {
        pubkey: author.pubkey,
        label: author.displayName,
        handle: author.handle,
        ...(author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
      },
    };
  });
  // Identity preserved when nothing was filled in, so the selection effect and
  // the memoised groups below do not churn on every unrelated batch.
  return changed ? out : items;
}

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenProfile(pubkey: string): void;
  onOpenNote(id: string): void;
  onOpenHashtag(tag: string): void;
}

/**
 * The search palette.
 *
 * Two structural choices carry the interaction.
 *
 * **Selection is a key, not an index.** The result list is rebuilt on every
 * keystroke, and an index into it means the highlight lands on whatever row happens
 * to occupy position four afterwards — so a reader who arrows down and keeps typing
 * has the selection wander onto something they never looked at, and Enter opens it.
 * A key resolves to a row if that row is still present and falls back to the top if
 * it is not, which is what "the list changed" should do.
 *
 * **Typing is deferred, not debounced.** `useDeferredValue` lets the field update at
 * input priority while the ranking re-runs at transition priority, so a fast typist
 * never waits on a scan of a few thousand candidates. A timer would do the same for
 * throughput and make the field itself lag, which is the one thing a search box may
 * not do. The relay half has a real debounce, for a different reason — see
 * `useRelaySearch`.
 */
export function SearchPalette({
  open,
  onOpenChange,
  onOpenProfile,
  onOpenNote,
  onOpenHashtag,
}: SearchPaletteProps) {
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const intent = useMemo(() => parseSearchInput(deferred), [deferred]);
  const relay = useRelaySearch(open, deferred);
  const corpus = useSearchCorpus(open, relay.completed);

  const matched = useMemo(
    () =>
      buildSearchItems({
        intent,
        people: corpus.people,
        notes: corpus.notes,
        byPubkey: corpus.byPubkey,
      }),
    [intent, corpus],
  );

  /*
   * Fill in the names of note authors this device has the note but not the
   * profile for.
   *
   * That gap is the common case, not an edge one: a text match reaches back weeks,
   * while kind-0s are only fetched for what has been *displayed*, so most matches
   * from beyond the last few screens have an author nobody has resolved. The
   * profile batcher exists for exactly this — one coalesced, rate-limited request
   * for the authors on screen — and it is asked only about rows that are actually
   * being shown, so a query nobody scrolls costs one batch rather than one per
   * candidate.
   */
  const unresolvedAuthors = useMemo(() => {
    const out: string[] = [];
    for (const item of matched) {
      if (item.kind === "note" && item.author === undefined) {
        out.push(item.note.pubkey);
      }
    }
    return out;
  }, [matched]);
  const lateAuthors = useAuthors(unresolvedAuthors);

  const items = useMemo(
    () => withLateAuthors(matched, lateAuthors),
    [matched, lateAuthors],
  );
  const groups = useMemo(() => groupItems(items), [items]);

  const found = items.findIndex((item) => item.key === selectedKey);
  const selected = found >= 0 ? found : 0;
  const terms =
    intent.kind === "text" || intent.kind === "hashtag"
      ? intent.terms
      : NO_TERMS;

  /*
   * Keep the highlighted row visible.
   *
   * Queried by attribute rather than tracked with a ref per row: the rows are
   * remounted wholesale on every keystroke, so a ref map would need pruning to
   * avoid holding detached nodes, and the DOM already knows which row is selected.
   */
  useEffect(() => {
    listRef.current
      ?.querySelector("[data-selected]")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, items]);

  const close = useCallback(() => {
    // The query is cleared on close rather than kept. A palette that reopens
    // holding someone's last search shows stale results for a query they have
    // moved on from, and the first keystroke then edits it instead of starting it.
    setText("");
    setSelectedKey(null);
    onOpenChange(false);
  }, [onOpenChange]);

  const activate = useCallback(
    (item: SearchItem | undefined) => {
      if (!item) return;
      const { action } = item;
      if (action.kind === "profile") onOpenProfile(action.pubkey);
      else if (action.kind === "note") onOpenNote(action.id);
      else onOpenHashtag(action.tag);
      close();
    },
    [close, onOpenHashtag, onOpenNote, onOpenProfile],
  );

  const move = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      // Wraps: with a list this short, an arrow key that does nothing at the end
      // reads as the palette having stopped responding.
      const next = (selected + delta + items.length) % items.length;
      setSelectedKey(items[next]?.key ?? null);
    },
    [items, selected],
  );

  const busy = corpus.loading || relay.status === "searching";

  return (
    <PaletteDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="Search"
    >
      <PaletteField
        icon={<Search />}
        placeholder="Search people, notes, npub, note id, #hashtag"
        aria-label="Search"
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls="setu-search-results"
        aria-activedescendant={
          items.length > 0 ? `setu-search-${items[selected]?.key}` : undefined
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            activate(items[selected]);
          }
        }}
        trailing={
          busy ? (
            <Spinner
              className="size-3.5 border-2 text-muted-foreground"
              aria-label="Searching"
            />
          ) : null
        }
      />

      <PaletteList
        id="setu-search-results"
        aria-label="Search results"
        ref={listRef}
      >
        {intent.kind === "secret" ? (
          <SecretKeyWarning />
        ) : intent.kind === "empty" ? (
          <SearchHelp />
        ) : items.length === 0 ? (
          intent.kind === "ref" ? (
            <SearchNotice>
              That link addresses an article by coordinate (naddr). Setu has no
              screen that takes one yet, so there is nothing to open from here.
            </SearchNotice>
          ) : corpus.loading ? (
            <SearchNotice>Reading this device's index…</SearchNotice>
          ) : (
            <EmptySearchReason relay={relay} corpus={corpus} />
          )
        ) : (
          groups.map((group) => (
            <PaletteGroup key={group.group} label={GROUP_LABELS[group.group]}>
              {group.items.map((item) => (
                <SearchResultRow
                  key={item.key}
                  id={`setu-search-${item.key}`}
                  item={item}
                  terms={terms}
                  selected={item.key === items[selected]?.key}
                  onActivate={() => activate(item)}
                  onHover={() => setSelectedKey(item.key)}
                />
              ))}
            </PaletteGroup>
          ))
        )}
      </PaletteList>

      <SearchFooter relay={relay} corpus={corpus} />
    </PaletteDialog>
  );
}
