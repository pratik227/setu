import type { NostrEvent } from "@setu/protocol";
import {
  Button,
  ContentHeader,
  EmptyState,
  ScrollArea,
  type TabDefinition,
  TabList,
  tabPanelProps,
} from "@setu/ui";
import { FileText, PenLine } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import { ArticleEditor } from "./ArticleEditor";
import { ArticleList } from "./ArticleList";
import { ArticleReader } from "./ArticleReader";
import type { ArticleRow } from "./articleViews";
import {
  type ArticleDraft,
  newArticleIdentifier,
  parseArticle,
} from "./buildArticle";
import { useOwnArticles } from "./useOwnArticles";

/**
 * Articles: the author's own long-form writing.
 *
 * Two panes. The list on the left is a projection of the local store — the
 * author's own kind-30024 and kind-30023 — and the right pane is whichever of
 * three things is currently true: an editor, a reading view, or an empty state
 * that says *why* it is empty.
 *
 * The empty states are the part worth being careful about. "Nothing here" is
 * three completely different situations for a Nostr client, and conflating them
 * leaves the author unable to tell a broken client from an empty one:
 *
 *  - **Not signed in.** There is no author, so there is nothing to look for.
 *  - **Signed in, read-only.** There may well be articles; they simply cannot be
 *    written or published. A read-only session is never offered a Write button,
 *    because a button that cannot work is worse than an explanation.
 *  - **Signed in and able to sign, with nothing written.** The only one of the
 *    three where an invitation to start writing is the right response.
 */

const TABS: readonly TabDefinition[] = [
  { id: "drafts", label: "Drafts" },
  { id: "published", label: "Published" },
];

const ID_PREFIX = "articles";

type TabId = "drafts" | "published";

/**
 * Random suffix for a new article's address.
 *
 * `crypto.getRandomValues`, never `Math.random`. The suffix becomes part of the
 * `d` identifier, which is a *permanent* public address: it is what keeps two
 * articles with the same title from overwriting each other, it appears in every
 * `naddr` anyone shares, and it can never be changed afterwards. `Math.random`
 * is seeded per-context and is not required to be unpredictable, so two tabs
 * opening a new article in the same tick can plausibly collide.
 */
function randomIdentifierSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the right pane is showing. */
type Pane =
  | { readonly mode: "empty" }
  | {
      readonly mode: "edit";
      readonly draft: ArticleDraft;
      /** ms epoch of the relay copy; absent for an article never sent anywhere. */
      readonly relaySavedAt?: number;
      readonly alreadyPublished: boolean;
      /** Row id, for list highlighting. */
      readonly rowId?: string;
    }
  | {
      readonly mode: "read";
      readonly event: NostrEvent;
      readonly rowId: string;
    };

export interface ArticlesScreenProps {
  onOpenProfile?(pubkey: string): void;
  onOpenHashtag?(tag: string): void;
}

export function ArticlesScreen({
  onOpenProfile,
  onOpenHashtag,
}: ArticlesScreenProps) {
  const { session } = useSession();
  const [tab, setTab] = useState<TabId>("drafts");
  const [pane, setPane] = useState<Pane>({ mode: "empty" });

  const { drafts, published } = useOwnArticles(session?.pubkey);
  const rows = tab === "drafts" ? drafts : published;

  /** Identifiers that already exist as a published article. */
  const publishedIdentifiers = useMemo(
    () => new Set(published.map((row) => row.identifier)),
    [published],
  );

  const startNew = useCallback(() => {
    setPane({
      mode: "edit",
      draft: {
        // The identifier is minted once, here, and then never changes — not on
        // save, not on publish, not on any later edit. It is the article.
        identifier: newArticleIdentifier("", randomIdentifierSuffix()),
        title: "",
        content: "",
      },
      alreadyPublished: false,
    });
  }, []);

  const openForEdit = useCallback(
    (row: ArticleRow) => {
      setPane({
        mode: "edit",
        // Parsed from the event, so the identifier and `published_at` carried by
        // the event survive into the next publish rather than being re-invented.
        draft: parseArticle(row.event),
        relaySavedAt: row.event.created_at * 1000,
        alreadyPublished:
          !row.draft || publishedIdentifiers.has(row.identifier),
        rowId: row.id,
      });
    },
    [publishedIdentifiers],
  );

  const openForReading = useCallback((row: ArticleRow) => {
    setPane({ mode: "read", event: row.event, rowId: row.id });
  }, []);

  const closePane = useCallback(() => setPane({ mode: "empty" }), []);

  const selectedId = pane.mode === "empty" ? undefined : pane.rowId;
  const canWrite = Boolean(session?.canSign);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* The list keeps its own scroll container and a fixed header, per the
          screen convention. Under `lg` the two panes stack, and the list is
          capped in height so the editor below it is still reachable without
          scrolling past every article first. */}
      <div className="flex min-h-0 max-h-80 shrink-0 flex-col border-b border-border lg:max-h-none lg:h-auto lg:w-96 lg:border-r lg:border-b-0">
        <ContentHeader className="justify-start gap-2">
          <TabList
            tabs={TABS}
            value={tab}
            onChange={(id) =>
              setTab(id === "published" ? "published" : "drafts")
            }
            label="Article sections"
            idPrefix={ID_PREFIX}
          />
          {canWrite ? (
            <Button size="sm" className="ml-auto" onClick={startNew}>
              <PenLine />
              Write
            </Button>
          ) : null}
        </ContentHeader>

        <ScrollArea {...tabPanelProps(tab, ID_PREFIX)}>
          {rows.length > 0 ? (
            <ArticleList
              rows={rows}
              {...(selectedId !== undefined ? { selectedId } : {})}
              onEdit={openForEdit}
              onRead={openForReading}
            />
          ) : (
            <ListEmptyState
              tab={tab}
              signedIn={session !== undefined}
              canWrite={canWrite}
              onWrite={startNew}
            />
          )}
        </ScrollArea>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {pane.mode === "edit" ? (
          <ArticleEditor
            // Remounting per article is deliberate: the editor holds the form
            // state and the local-autosave restore decision for one identifier,
            // and carrying either into a different article would save one
            // article's words over another's address.
            key={pane.draft.identifier}
            initial={pane.draft}
            pubkey={session?.pubkey}
            canSign={canWrite}
            {...(pane.relaySavedAt !== undefined
              ? { relaySavedAt: pane.relaySavedAt }
              : {})}
            alreadyPublished={pane.alreadyPublished}
            onClose={closePane}
          />
        ) : pane.mode === "read" ? (
          <ArticleReader
            event={pane.event}
            onClose={closePane}
            {...(onOpenProfile ? { onOpenProfile } : {})}
            {...(onOpenHashtag ? { onOpenHashtag } : {})}
          />
        ) : (
          <EditorEmptyState
            signedIn={session !== undefined}
            canWrite={canWrite}
            onWrite={startNew}
          />
        )}
      </div>
    </div>
  );
}

function ListEmptyState({
  tab,
  signedIn,
  canWrite,
  onWrite,
}: {
  tab: TabId;
  signedIn: boolean;
  canWrite: boolean;
  onWrite(): void;
}) {
  if (!signedIn) {
    return (
      <EmptyState
        icon={<FileText className="size-5" />}
        title="Sign in to see your articles"
        description="Articles are addressed to an account, so there is nothing to look for until there is one."
      />
    );
  }

  if (!canWrite) {
    return (
      <EmptyState
        icon={<FileText className="size-5" />}
        title={
          tab === "drafts"
            ? "No drafts on your relays"
            : "Nothing published yet"
        }
        // No Write button here: this session cannot sign, so the button could
        // only ever fail. Saying why is more use than offering it.
        description="This is a read-only session. Articles you have already published will appear here as your relays return them, but nothing can be written or signed."
      />
    );
  }

  return (
    <EmptyState
      icon={<FileText className="size-5" />}
      title={tab === "drafts" ? "No drafts yet" : "Nothing published yet"}
      description={
        tab === "drafts"
          ? "Drafts saved to your relays appear here. Work in progress is autosaved in this browser until you save it to a relay."
          : "Articles you publish appear here, newest first."
      }
      action={
        <Button size="sm" onClick={onWrite}>
          <PenLine />
          Write an article
        </Button>
      }
    />
  );
}

function EditorEmptyState({
  signedIn,
  canWrite,
  onWrite,
}: {
  signedIn: boolean;
  canWrite: boolean;
  onWrite(): void;
}) {
  if (!signedIn) {
    return (
      <EmptyState
        icon={<PenLine className="size-5" />}
        title="Not signed in"
        description="Long-form articles are signed events. Sign in to write one."
      />
    );
  }
  if (!canWrite) {
    return (
      <EmptyState
        icon={<PenLine className="size-5" />}
        title="Read-only session"
        description="You can open and read your articles, but publishing needs a key that can sign. Unlock this session or sign in with a signing extension."
      />
    );
  }
  return (
    <EmptyState
      icon={<PenLine className="size-5" />}
      title="Nothing open"
      description="Pick an article on the left, or start a new one."
      action={
        <Button size="sm" onClick={onWrite}>
          <PenLine />
          Write an article
        </Button>
      }
    />
  );
}
