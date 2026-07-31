import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  cn,
  PaletteOption,
} from "@setu/ui";
import { AtSign, FileText, Hash } from "lucide-react";
import type { ReactNode } from "react";
import { relativeTime } from "../notes/relativeTime";
import { highlight, snippet } from "./localMatch";
import type {
  CommandItem,
  NoteItem,
  PersonItem,
  SearchItem,
} from "./searchItems";

/**
 * Matched runs shown in bold rather than in the accent colour.
 *
 * Weight survives both themes and every accent the theme engine can derive; a
 * highlight colour has to be re-checked for contrast against each one, and gets it
 * wrong silently. Rendered as elements over pre-split data — never as an HTML
 * string, because the text is note content and building markup from it would put
 * user-authored input through `dangerouslySetInnerHTML`.
 */
function Highlighted({
  text,
  terms,
}: {
  text: string;
  terms: readonly string[];
}) {
  return (
    <>
      {highlight(text, terms).map((segment, index) =>
        segment.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
          <strong key={index} className="font-semibold text-foreground">
            {segment.text}
          </strong>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

interface RowProps {
  readonly id: string;
  readonly selected: boolean;
  readonly terms: readonly string[];
  onActivate(): void;
  /** Hover selects, so pointer and keyboard share one notion of "next Enter". */
  onHover(): void;
}

function Row({
  id,
  selected,
  onActivate,
  onHover,
  children,
}: RowProps & { children: ReactNode }) {
  return (
    <PaletteOption
      id={id}
      selected={selected}
      onMouseMove={onHover}
      // `onMouseDown` rather than `onClick`: the input owns focus for the whole
      // interaction, and a click first blurs it, which on a Radix dialog can
      // move focus before the handler runs.
      onMouseDown={(event) => {
        event.preventDefault();
        onActivate();
      }}
    >
      {children}
    </PaletteOption>
  );
}

export function PersonResultRow({
  item,
  ...row
}: RowProps & { item: PersonItem }) {
  const { person } = item;
  return (
    <Row {...row}>
      <Avatar className="size-7 shrink-0">
        {person.avatarUrl ? (
          <AvatarImage src={person.avatarUrl} alt="" />
        ) : null}
        <AvatarFallback>
          {person.label.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          <Highlighted text={person.label} terms={row.terms} />
        </span>
        {/* The identifier as published, with no verification mark. A checkmark
            here would assert a NIP-05 round trip this palette has not made. */}
        <span className="block truncate text-xs text-muted-foreground">
          <Highlighted text={person.handle} terms={row.terms} />
        </span>
      </span>
      {/* No trailing type icon. The avatar already says this row is a person,
          and a glyph repeated down every row of the largest group is the kind of
          decoration that makes a dense list read as busier than it is. */}
    </Row>
  );
}

export function NoteResultRow({ item, ...row }: RowProps & { item: NoteItem }) {
  const author = item.author;
  return (
    <Row {...row}>
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          <Highlighted
            text={snippet(item.note.content, row.terms)}
            terms={row.terms}
          />
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {/* An unresolved author is named as unresolved rather than shown as a
              raw key: a 64-character hex string in a result row reads as data
              corruption, and the profile may simply not have arrived yet. */}
          {author ? author.label : "author not fetched yet"} ·{" "}
          {relativeTime(item.note.createdAt)}
        </span>
      </span>
    </Row>
  );
}

export function CommandResultRow({
  item,
  ...row
}: RowProps & { item: CommandItem }) {
  const Icon =
    item.action.kind === "hashtag"
      ? Hash
      : item.action.kind === "profile"
        ? AtSign
        : FileText;
  return (
    <Row {...row}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {item.hint}
        </span>
      </span>
    </Row>
  );
}

/** Dispatch on the row kind, so the palette body stays a list and a switch. */
export function SearchResultRow({
  item,
  ...row
}: RowProps & { item: SearchItem }) {
  if (item.kind === "person") return <PersonResultRow item={item} {...row} />;
  if (item.kind === "note") return <NoteResultRow item={item} {...row} />;
  return <CommandResultRow item={item} {...row} />;
}

/** Label above each block. Short, because the rows carry their own meaning. */
export const GROUP_LABELS = {
  jump: "Go to",
  people: "People in your local index",
  notes: "Notes in your local index",
} as const;

/** Shared padding for the notices the palette renders in place of results. */
export function SearchNotice({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "px-4 py-6 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
