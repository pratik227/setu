/**
 * Thread shape, as a pure function of the events we hold.
 *
 * Threading is the one place where a client is tempted to keep a mutable graph
 * on the side — parent pointers patched as events arrive, children arrays
 * appended in place. That graph then disagrees with the store, and nothing can
 * say which is right. So this module is a *projection*: hand it every event
 * currently held and the id in focus, get back the chain above, the tree below,
 * and the list of ids still missing. No state, no I/O, no store access.
 *
 * NIP-10 resolution itself is not reimplemented here — `rootAndReplyIds()` in
 * `@setu/protocol` already handles marked and legacy positional `e` tags.
 */

import { eTags, type NostrEvent, rootAndReplyIds } from "@setu/protocol";

/**
 * Indentation ceiling for nested replies.
 *
 * The thread lives in a ~380px panel. Indenting every level would shrink a
 * ten-deep chain to a sliver of readable width, so past this depth replies keep
 * their true position in the ordering but stop moving right.
 */
export const MAX_INDENT_DEPTH = 3;

/** Hard cap on ids the tree will report as fetchable, so a hostile chain of
 * `e` tags cannot grow the subscription filter without bound. */
export const MAX_MISSING_IDS = 32;

/**
 * One rung of the ancestor chain.
 *
 * A gap is represented explicitly rather than skipped: the parent of a reply is
 * either an event we hold or a known-unavailable id, and collapsing the second
 * case into the first would silently reparent a reply onto its grandparent.
 */
export type AncestorSlot =
  | { readonly type: "note"; readonly id: string; readonly event: NostrEvent }
  | { readonly type: "missing"; readonly id: string };

export interface ThreadReply {
  readonly event: NostrEvent;
  /** Indentation level, clamped to `maxIndentDepth`. */
  readonly depth: number;
  /** True depth below the focused note, unclamped. */
  readonly rawDepth: number;
  /**
   * The reply's parent is not held locally, so it is shown at the top level
   * rather than dropped. Flagged so the row can say so.
   */
  readonly orphaned: boolean;
}

export interface ThreadTree {
  /** The thread's root per NIP-10 — the focused id itself when it is the root. */
  readonly rootId: string;
  /** Root-most first, direct parent last. Empty when the focus is the root. */
  readonly ancestors: readonly AncestorSlot[];
  /** Undefined until the focused event is held locally. */
  readonly focused: NostrEvent | undefined;
  /** Pre-order, siblings oldest first. Orphans come last. */
  readonly replies: readonly ThreadReply[];
  /** Ids the thread references but does not hold — what is worth fetching. */
  readonly missingIds: readonly string[];
}

export interface BuildThreadOptions {
  /** Every event held that might belong to this thread. Order is irrelevant. */
  readonly events: readonly NostrEvent[];
  readonly focusedId: string;
  readonly maxIndentDepth?: number;
}

/** Oldest first — the reading order for a conversation. */
function byCreatedAtAscending(a: NostrEvent, b: NostrEvent): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  // Deterministic tiebreak so the same input always renders the same order.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The direct parent id of an event, or undefined when it starts a thread. */
function parentIdOf(event: NostrEvent): string | undefined {
  const parent = rootAndReplyIds(event).reply;
  // An event tagging itself as its own parent is not a tree edge. Following it
  // would be an immediate one-node cycle.
  return parent === event.id ? undefined : parent;
}

interface AncestorWalk {
  readonly slots: readonly AncestorSlot[];
  /** Focused id plus every id visited walking up, including missing rungs. */
  readonly visited: ReadonlySet<string>;
}

/**
 * Walks from the focused event to the top of the chain.
 *
 * Every id seen is recorded, and revisiting one ends the walk. That is the cycle
 * guard: an event whose `e` tag points at one of its own descendants forms a
 * loop, and without the check the walk would run until the stack or the tab
 * dies. Nothing about a signed event stops an author from publishing that.
 */
function walkAncestors(
  index: ReadonlyMap<string, NostrEvent>,
  focused: NostrEvent,
  declaredRoot: string | undefined,
  missing: Set<string>,
): AncestorWalk {
  const slots: AncestorSlot[] = [];
  const visited = new Set<string>([focused.id]);
  let current = focused;

  for (;;) {
    const parentId = parentIdOf(current);
    if (parentId === undefined) break;
    if (visited.has(parentId)) break;
    visited.add(parentId);

    const parent = index.get(parentId);
    if (parent === undefined) {
      // The chain cannot continue through an event we do not hold: its own
      // `e` tags are unknown. Record the gap and stop climbing.
      slots.push({ type: "missing", id: parentId });
      missing.add(parentId);
      break;
    }
    slots.push({ type: "note", id: parent.id, event: parent });
    current = parent;
  }

  slots.reverse();

  // A gap does not have to hide the thread's origin: NIP-10 names the root
  // directly, so when we hold it we can show it above the gap.
  if (declaredRoot !== undefined && !visited.has(declaredRoot)) {
    const root = index.get(declaredRoot);
    if (root === undefined) missing.add(declaredRoot);
    else {
      slots.unshift({ type: "note", id: root.id, event: root });
      visited.add(root.id);
    }
  }

  return { slots, visited };
}

/** True when an event places itself in this thread by tagging the root. */
function belongsToThread(event: NostrEvent, rootId: string): boolean {
  if (rootAndReplyIds(event).root === rootId) return true;
  return eTags(event).includes(rootId);
}

/**
 * Builds the reply tree below the focused event.
 *
 * Descent is iterative with a visited set, for the same reason the upward walk
 * has one: a cycle among reply tags must terminate, not recurse.
 */
function buildReplies(
  index: ReadonlyMap<string, NostrEvent>,
  focusedId: string,
  rootId: string,
  excluded: ReadonlySet<string>,
  maxIndent: number,
  missing: Set<string>,
): readonly ThreadReply[] {
  const children = new Map<string, NostrEvent[]>();
  for (const event of index.values()) {
    if (event.id === focusedId) continue;
    const parentId = parentIdOf(event);
    if (parentId === undefined) continue;
    const bucket = children.get(parentId);
    if (bucket === undefined) children.set(parentId, [event]);
    else bucket.push(event);
  }
  for (const bucket of children.values()) bucket.sort(byCreatedAtAscending);

  const replies: ThreadReply[] = [];
  const visited = new Set<string>([focusedId, ...excluded]);

  /** Depth-first descent from one id. Iterative, so a cycle cannot recurse. */
  const expand = (from: string, startDepth: number) => {
    const stack: { event: NostrEvent; rawDepth: number }[] = [];
    const seed = children.get(from) ?? [];
    for (let i = seed.length - 1; i >= 0; i -= 1) {
      stack.push({ event: seed[i] as NostrEvent, rawDepth: startDepth });
    }
    while (stack.length > 0) {
      const node = stack.pop() as { event: NostrEvent; rawDepth: number };
      if (visited.has(node.event.id)) continue;
      visited.add(node.event.id);
      replies.push({
        event: node.event,
        depth: Math.min(node.rawDepth, maxIndent),
        rawDepth: node.rawDepth,
        orphaned: false,
      });
      const kids = children.get(node.event.id) ?? [];
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        stack.push({
          event: kids[i] as NostrEvent,
          rawDepth: node.rawDepth + 1,
        });
      }
    }
  };

  expand(focusedId, 1);

  // Replies whose direct parent never arrived. Dropping them would hide real
  // conversation, and guessing a parent would invent structure the events do
  // not carry, so they are shown at the top level and marked.
  const orphans: NostrEvent[] = [];
  for (const event of index.values()) {
    if (visited.has(event.id)) continue;
    const parentId = parentIdOf(event);
    if (parentId === undefined) continue;
    if (index.has(parentId)) continue;
    if (!belongsToThread(event, rootId)) continue;
    orphans.push(event);
    missing.add(parentId);
  }
  orphans.sort(byCreatedAtAscending);

  for (const orphan of orphans) {
    if (visited.has(orphan.id)) continue;
    visited.add(orphan.id);
    replies.push({ event: orphan, depth: 1, rawDepth: 1, orphaned: true });
    expand(orphan.id, 2);
  }

  return replies;
}

/** Project the held events into the thread around `focusedId`. */
export function buildThread(options: BuildThreadOptions): ThreadTree {
  const { focusedId } = options;
  const maxIndent = Math.max(1, options.maxIndentDepth ?? MAX_INDENT_DEPTH);

  const index = new Map<string, NostrEvent>();
  for (const event of options.events) {
    // First writer wins: the store already resolved duplicates by id, so a
    // second copy carries no new information.
    if (!index.has(event.id)) index.set(event.id, event);
  }

  const missing = new Set<string>();
  const focused = index.get(focusedId);

  if (focused === undefined) {
    // Nothing to project yet. The focused id is the one thing worth fetching.
    return {
      rootId: focusedId,
      ancestors: [],
      focused: undefined,
      replies: [],
      missingIds: [focusedId],
    };
  }

  const declaredRoot = rootAndReplyIds(focused).root;
  // NIP-10 makes the author's declared root authoritative. Falling back to the
  // focused id covers both a top-level note and an event with no `e` tags.
  const rootId = declaredRoot ?? focusedId;

  const { slots, visited } = walkAncestors(
    index,
    focused,
    declaredRoot,
    missing,
  );

  const replies = buildReplies(
    index,
    focusedId,
    rootId,
    visited,
    maxIndent,
    missing,
  );

  const missingIds: string[] = [];
  for (const id of missing) {
    if (index.has(id)) continue;
    if (missingIds.length >= MAX_MISSING_IDS) break;
    missingIds.push(id);
  }

  return { rootId, ancestors: slots, focused, replies, missingIds };
}

/** Distinct pubkeys the tree needs author metadata for. */
export function threadPubkeys(tree: ThreadTree): string[] {
  const set = new Set<string>();
  for (const slot of tree.ancestors) {
    if (slot.type === "note") set.add(slot.event.pubkey);
  }
  if (tree.focused) set.add(tree.focused.pubkey);
  for (const reply of tree.replies) set.add(reply.event.pubkey);
  return [...set];
}

/** Distinct event ids the tree needs interaction counts for. */
export function threadNoteIds(tree: ThreadTree): string[] {
  const set = new Set<string>();
  for (const slot of tree.ancestors) {
    if (slot.type === "note") set.add(slot.id);
  }
  if (tree.focused) set.add(tree.focused.id);
  for (const reply of tree.replies) set.add(reply.event.id);
  return [...set];
}

/** Every event in the tree, in render order. */
export function threadEvents(tree: ThreadTree): readonly NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const slot of tree.ancestors) {
    if (slot.type === "note") out.push(slot.event);
  }
  if (tree.focused) out.push(tree.focused);
  for (const reply of tree.replies) out.push(reply.event);
  return out;
}
