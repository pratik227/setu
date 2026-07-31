/**
 * The Markdown AST.
 *
 * Data only, with no imports: the parser, the renderer and the excerpt builder
 * all speak this shape, and a types module that depends on nothing cannot become
 * the centre of an import cycle between them.
 *
 * A node in this tree is the *result* of a safety decision, never a place one is
 * still pending. A `link` node holds an already-allowlisted `href`; there is no
 * representation for an unsafe one, so a renderer cannot emit what a parser
 * refused.
 */

export type MarkdownInline =
  | { readonly type: "text"; readonly value: string }
  /** Explicit line break — two trailing spaces or a trailing backslash. */
  | { readonly type: "break" }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "strong"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "em"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "strike"; readonly children: readonly MarkdownInline[] }
  | {
      readonly type: "link";
      /** Already sanitized: an unsafe destination never reaches this node. */
      readonly href: string;
      readonly children: readonly MarkdownInline[];
    }
  | {
      readonly type: "image";
      readonly src: string;
      readonly alt: string;
    };

export interface MarkdownListItem {
  readonly children: readonly MarkdownInline[];
  readonly sublist?: MarkdownList;
}

export interface MarkdownList {
  readonly ordered: boolean;
  /** First number of an ordered list, so `5.` starts at five. */
  readonly start: number;
  readonly items: readonly MarkdownListItem[];
}

export type MarkdownBlock =
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly type: "paragraph"; readonly children: readonly MarkdownInline[] }
  | {
      readonly type: "codeBlock";
      readonly language?: string;
      readonly value: string;
    }
  | { readonly type: "quote"; readonly blocks: readonly MarkdownBlock[] }
  | { readonly type: "list"; readonly list: MarkdownList }
  | { readonly type: "rule" };

/**
 * Longest source we will parse. An article is prose; a ten-megabyte body is
 * either a mistake or an attempt to make one reader's tab the cost of one
 * relay's bandwidth. Beyond this the tail is dropped rather than parsed.
 */
