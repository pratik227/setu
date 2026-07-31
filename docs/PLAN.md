# Setu — Product & Engineering Plan

*A Nostr social client for web and desktop. "Setu" is Sanskrit for **bridge**.*

---

## 1. What Setu is

A **Twitter-shaped Nostr client** — home feed, threads, profiles, zaps,
notifications — shipping as a web app and a Tauri 2 desktop app from one React 19
codebase.

Positioning: fast enough to feel like a hosted product, honest enough to verify
everything locally, and comfortable enough to read for an hour.

### Decisions locked
| Decision | Choice |
|---|---|
| Platform v1 | Web + desktop (Tauri 2 + React 19); mobile later |
| Product v1 | Social feed client; chat/communities deferred |
| Visual design | Calm warm-neutral surface, single teal accent |
| License | **Apache-2.0** |

---

## 2. Design principles

These are the non-negotiables. Each one exists because the opposite choice is a
well-trodden path to a client that is fast to build and impossible to fix.

**The local store is the only source of truth, and it is the event bus.** Relays
are writers into it; the UI is a reader of it. Nothing else. The failure mode this
prevents is a second in-memory graph growing alongside the store — after which
every write has two destinations, they drift, and nothing can answer what the
client actually knows. There is no view-model cache, and a note the user just
published reaches the screen by the same path as a note from a relay.

**Every signature is verified, locally, always.** Verification is batched off the
receive path so it never blocks a frame, but there is exactly one verification
function and no configuration that disables it. A client whose authenticity check
can be bypassed makes every trust decision downstream of it meaningless — and
"the server already checked" is not a check.

**Reads follow the outbox model.** A query about an author goes to *that author's*
write relays, so a filter is never meaningful on its own: it is always "this
query, at this relay". Binding the relay into the filter type makes it impossible
to accidentally broadcast a per-author query to every open socket.

**Watermarks are per relay.** A single global `since` is wrong the moment two
relays disagree, which is always: if A is caught up to T and B is an hour behind,
asking both for `since = T` permanently loses everything B owed.

**Pagination exists from day one.** Without `until`-based scroll-back a feed can
only reach as far as the local store happens to hold, and retrofitting it later
means reworking the subscription layer.

**Deletions are enforced in storage, not in views.** A NIP-09 tombstone blocks
insertion and outlives its target, so a relay handing a deleted event back later
cannot resurrect it. Correctness must not depend on UI code remembering to check.

**Nothing may become a god object.** A 700-line ceiling is enforced by CI, and the
layer graph (`protocol ← core ← app`) is enforced by a lint script with a headless
CLI as the proof. Caches that also parse, view models that also own networking,
and switch statements that also mutate globals all start as reasonable files.

## 3. Architecture

```
setu/
  packages/
    protocol/   # wire types, kinds (NIP-per-file), codecs, content tokenizer, signers
    core/       # headless engine: EventStore, RelayPool, SubscriptionManager,
                # FeedEngine, OutboxRouter, ProfileBatcher, verifier — NO React
    ui/         # design system: tokens, theme engine, primitives, shell
  apps/
    web/        # Vite + React 19
    desktop/    # Tauri 2 shell (planned)
    cli/        # headless consumer of core — the layer-enforcement mechanism
  scripts/      # CI guards: px-text, file-size, layer-imports
```

Dependency rule, lint-enforced: `protocol ← core ← app ← apps/*`; `ui` imports
neither `core` nor `protocol`; features import only from `shared/`.

### Data flow — local-first, store as event bus

```
relays ──ws──► RelayPool ──raw──► VerifierPool (WASM secp256k1, batched, worker)
                                       │ verified events only
                                       ▼
                              EventStore (IndexedDB / Dexie)
                              · dedup + provenance merge
                              · replaceable/addressable LWW (lexical-id tiebreak)
                              · NIP-09 deletion enforced AT INSERT
                              · ingest-time content tokenization
                                       │ observable projections
                                       ▼
             FeedEngine · ProfileBatcher · ThreadResolver · Notifications
                                       │
                                       ▼
                                     React
```

UI reads only from the store; subscriptions are writers. Publishing writes
locally first (instant echo), then fans out with per-relay OK tracking.
**Signature verification is always on**, batched in a worker.

### Protocol layer choice
Built on `nostr-tools` primitives rather than adopting a framework (NDK) whole.
Every studied client's biggest regret is an architecture it couldn't change; NDK
bakes in its own cache/outbox opinions and we'd fight it exactly where our
patterns are stronger (per-relay `since`, insert-blocking deletions, worker-side
verification). The boundary stays clean so a Rust/WASM core can replace hot paths
later — which is also the future shared core for mobile.

### Subscriptions & feeds
Per-relay filters from the outbox model; per-relay `since` with an overlap window;
**`until` pagination from day one**; a staging buffer so new notes don't jump the
reader (flushed by a "new posts" chip); batched, rate-limited profile loading.

### Keys & signing
One async `NostrSigner`: NIP-07 extension (web default), local key (OS keychain
on desktop, NIP-49-encrypted at rest on web), NIP-46 bunker. Compose-box guard
refuses text containing `nsec1…`. Multi-account UI is v1.1, but **all storage is
account-keyed from day one** plus a singleton-reset registry.

### NIP surface for v1
01/10, 02, 05, 07, 09, 18, 19/21/27, 23 (read), 24, 25, 30 (render), 36, 42, 46,
49, 50, 51 (mutes, follow packs read), 57 (display + LNURL pay-out), 65, 89,
92/94, Blossom. **Deferred:** NIP-17 DMs, in-app NWC, NIP-29 groups, live
streaming.

---

## 4. Design system

**Foundation.** Tailwind v4 + shadcn/Radix; HSL-triplet tokens; `--radius:
0.625rem`; Inter Variable; note body `text-base` (16px) with meta on
`text-xs`/`text-2xs`; rem-only enforced by `check-px-text`; lucide at `size-4`;
36px avatars; quiet scrollbars; `content-visibility` on feed rows.

**Palette.** Light: warm off-white paper (`40 20% 98%`), near-black ink, teal
primary (`176 58% 32%`). Dark: cool near-black (`220 12% 9%`), warm-tinted ink,
brighter teal (`174 55% 52%`). Chrome sits one step *below* the reading surface,
separated by a hairline. Nostr-semantic colors are fixed: zap gold, repost green,
like red, NIP-05 blue.

**Motion.** Durations 120/180/240/500ms on the standard `easeOutQuart` and
`easeOutExpo` curves — a direct decay for feedback, a longer settle for entrances.
Signature: a 2px blur-in arrival for notes entering the timeline. Every animation
has a reduced-motion branch.

**Theme engine.** `deriveTheme(seed)` turns 3–4 colors into a coherent 30-variable
palette. Every step is taken in **CIE L\*** rather than in relative luminance or
raw channels, because L\* is perceptually uniform: a fixed step looks equally
subtle on a near-white theme and a near-black one, where a luminance step reads as
a gentle recession on the first and a hard band on the second. Chrome sits 2.6 L\*
below the canvas, lifting instead of sinking when there is no room left below.
Ships with Setu (hand-tuned, no derivation), Dawn (gradient), GitHub, Nord,
Gruvbox, Tokyo Night, Solarized; any syntax-highlighting theme is a drop-in seed.

**Layout.** Top chrome (40px, matched to macOS traffic lights) · sidebar (280px)
· reading-capped feed column (46rem) · optional 380px auxiliary panel. Threads
open in the **auxiliary panel** first — you keep your place in the feed while
reading a conversation. That is Setu's main structural departure from the usual
timeline client.

---

## 5. Engineering practices

- `pnpm ci` = lint + guards + typecheck + test + build.
- **File-size ceiling of 700 lines, enforced by script. Split; never raise it.**
- Layer-import guard: `core` may not import React; `ui` may not import `core`.
- `apps/cli` is a release gate — if a feature can't be exercised headlessly, it's
  in the wrong layer.
- Playwright screenshot script per theme × appearance; the gradient, card lift and
  interaction states are invisible in a diff and easy to break.
- Protocol golden tests: pinned event-id vectors, NIP-19 round-trips, tokenizer
  round-trip property.

---

## 6. Status

**Done — M0 foundation + M1 read-only client.**

*Tooling.* pnpm workspace, Biome, TS strict (`noUncheckedIndexedAccess`,
`verbatimModuleSyntax`), three CI guards (px-text, 700-line ceiling, layer
imports) — each verified to actually fail on a violation. `pnpm run verify` is
the gate; **354 tests pass** (protocol 222, core 114, web 18).

*`@setu/protocol`.* Kinds, event id/sign/**verify** (recomputes the id *and*
checks schnorr), filter matching, NIP-10 threading, total non-throwing NIP-19,
NIP-49, a single-pass content tokenizer with a round-trip guarantee, and three
signers (local / NIP-07 / read-only).

*`@setu/core`.* Two `EventStore` implementations (in-memory + Dexie) behind one
conformance suite, enforcing dedup with provenance merge, replaceable/addressable
LWW with the lexical-id tiebreaker, and NIP-09 deletions as insert-blocking
tombstones that survive re-delivery. Relay pool with backoff, blocked-relay
enforcement on every REQ *and* publish, refusal tracking, and a mandatory
timeout+failure path on every pending request. Subscription manager with per-relay
`since` watermarks and local-echo publishing. Feed engine with repost coalescing,
a staging buffer, and `until` pagination. Outbox router, profile batcher, and an
account-scope reset registry.

*`@setu/ui`.* Token layer, motion system, palette-derivation engine with 7 themes,
primitives, and the app shell.

*`@setu/web`.* **Renders live, signature-verified Nostr data**: home and hashtag
feeds, tokenized content (links, hashtags, mentions, code blocks, media hoisted
into a gallery), resolved profiles and avatars, repost attribution, interaction
counts, zap totals from BOLT11, NIP-36 blur-and-reveal, long-note clamping.

*`@setu/cli`.* `fetch`, `profile`, `decode`, `verify`, `tokenize` — verified
against live relays. It is the layer guard with teeth: core runs headless in Node
with no UI framework anywhere in its import graph.

### Bugs found and fixed while integrating

Worth recording, because each is a trap any Nostr client can fall into:

1. **BOLT11 amount misparse.** In `lnbc1...` the `1` is the bech32 separator, not
   an amount. A leading-anchored digit match reads it as 1 BTC and reports
   100,000,000 sats for an amountless zap. The amount must come from the
   human-readable part, which ends at the *last* `1` (the bech32 data charset
   excludes `1`).
2. **Debounce livelock.** Re-arming a timer on every change looks like a debounce
   but on a live feed the input changes faster than the delay, so the callback is
   pushed back forever. Profiles never resolved and showed npubs indefinitely.
   Both interest-tracking hooks now use a leading schedule.
3. **NIP-36 presence vs value.** A bare `["content-warning"]` tag carries no
   reason but still means "warn". Keying off the tag's *value* left sensitive
   notes unblurred.
4. **A dead relay stalls resolution.** Some relays answer 503 to a WebSocket
   upgrade carrying no User-Agent (so: Node, not browsers), and one
   permanently-failing relay in the set delayed profile completion for
   everything. Mitigated with a UA header and a healthier default relay set —
   the underlying robustness issue is the first item under Next.
5. **`window` in a shared package.** The NIP-07 signer referenced bare `window`,
   which made `@setu/protocol` uncompilable from Node. Now probes `globalThis`.
6. **`pnpm ci` is a builtin.** A script named `ci` silently ran a frozen install
   instead of the gate. Renamed to `verify`.

### Next

1. **Relay robustness:** a permanently-failing relay must not delay a `fetch`;
   fail it fast and complete on the survivors. This is now the blocker for a
   *first* follow too — see below.
2. Persist to `DexieEventStore` keyed per account, wired to the reset registry.
3. Notifications and mentions surfaces (both routes exist, both are placeholders).
4. Direct messages (NIP-17).
5. Viewport-driven metadata window (currently a fixed head of 40 rows).
6. Tauri shell: OS keychain, deep links, vibrancy, auto-update. NIP-05
   verification also needs it — many hosts omit CORS headers, so browser-side
   verification cannot complete for them and those handles stay unverified.

### Follow-list writes

Editing a follow list is the most destructive operation a Nostr client performs,
because kind 3 is *replaceable*: there is no "add a follow", only "here is my
whole list now". Three separate ways to lose data, all guarded:

- **Stale snapshot.** Every toggle re-fetches the newest kind-3 from the relays
  rather than trusting the local copy.
- **Unconfirmed absence.** "No list found" and "we did not finish asking" are
  indistinguishable, and treating the second as the first replaces a real list
  with a one-entry list. A first follow therefore requires *every* configured
  relay to be connected, and refuses with the unreachable relays named. Refusing
  is recoverable; publishing a truncated list is not.
- **Silent field loss.** `content` (which carries relay configuration in many
  clients), non-`p` tags, petnames and relay hints are all copied through
  verbatim. Unfollowing removes *every* duplicate entry for that pubkey, since
  removing only the first leaves the user still following them.

A final plausibility check blocks any write that moves the follow count by more
than one, on the grounds that no follow button produces that and it therefore
indicates a bug. 15 unit tests cover each case.

## 7. Top risks

| Risk | Mitigation |
|---|---|
| JS signature-verification throughput | WASM secp256k1, batched in a worker; benchmark against a 5k-event backfill in M1 |
| IndexedDB ceiling on large stores | Provenance-pruned store + LRU eviction; a Rust/SQLite core behind the same interface is the designed escape hatch |
| Relay misbehavior (limits, refusals, dropped EOSE) | Per-relay limit cache, REQ backoff, refusal tracking, and a mandatory timeout+failure path on every pending request |
| Scope creep toward chat | §3 deferrals are explicit; the shell makes chat a clean v2 rather than a v1 temptation |
| WKWebView quirks in Tauri | Already mitigated for two known ones (stale gradient rasters, HDR avatar clamping); expect more and test on the real shell early |
