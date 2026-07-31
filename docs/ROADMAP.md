# Setu — capability roadmap

Derived from a full audit of the Nostr NIP surface against what Setu implements.
The point of this document is the **third section**: deciding what not to build is
what keeps a client shippable.

Legend: ✅ protocol + UI · ◐ protocol only, no screen · ○ kind declared, unused ·
✗ absent

---

## 1. Where we are ahead

Worth recording so it does not get traded away in a refactor:

- **NIP-07** extension signing, and **NIP-49** encryption at rest for a local key.
- **NIP-09 deletions enforced at the storage insert boundary**, with tombstones
  persisted independently of their targets — so a relay handing a deleted event
  back later cannot resurrect it. Enforcing this in views instead means every new
  screen must remember to check.
- **Per-relay `since` watermarks** and **`until` pagination** from the start.
- **Signature verification with no bypass** — one function, no fast path, no
  configuration to disable it.
- A real local event store with a query planner, under a conformance suite that
  runs against both the in-memory and persistent implementations.

## 2. Ranked gaps

Ordered by user value for a feed-first web client, not by how impressive the
feature is.

| # | Gap | NIPs / kinds | Effort |
|---|---|---|---|
| 1 | Interaction row: like, repost, reply, delete | 25, 18, 10, 09 | S |
| 2 | Notifications + Mentions (routes exist, dead-end) | — | S/M |
| 3 | Quote-note embedding (currently a text chip) | 27, 19, 18 | S/M |
| 4 | Zap sending (we read receipts, cannot send) | 57, opt. 47 | M |
| 5 | Mute list — must filter *below* the UI, like deletions | 51 (+44) | M |
| 6 | Bookmarks (route + kind exist, dead-end) | 51 | S |
| 7 | Media upload — composer is text-only | B7 / 96+98, 92 | M |
| 8 | **NIP-42 relay AUTH** — without it, paid and private relays return nothing, which reads to the user as "the network is empty" | 42 | M |
| 9 | NIP-46 bunker signer (currently a stub constant) | 46, 44 | M/L |
| 10 | Search (`Filter.search` is typed and unused) | 50 | S/M |
| 11 | Settings that write: relay list, profile | 65, 24 | M |
| 12 | Article reader screen (parser already written) | 23 | S |
| 13 | `imeta` in the feed — kills media layout shift | 92, 94 | S |
| 14 | Report / block | 56 | S |
| 15 | Polls — feed-native, fits the counting machinery | 88 | M |
| 16 | Custom emoji, incl. emoji reactions | 30 | S |
| 17 | Picture and video kinds | 68, 71 | S/M |
| 18 | Settings sync with **no server** | 78 | S |
| 19 | DMs — the biggest "why can't this be my only client" | 17, 44, 59 | L |
| 20 | Multi-account UI (storage is already account-keyed) | — | M |
| 21 | Correctness cluster: expiration, protected events, `alt`, proxy badge, app handlers | 40, 70, 31, 48, 89 | S each |
| 22 | Wire the persistent store; viewport metadata window | — | S/M |

## 3. Explicitly not building, and why

This is the load-bearing half of the roadmap.

**Anything that requires trusting a server.** Our architecture verifies
everything locally, so these are excluded on principle, not on effort:

- **NIP-45 `COUNT`** — asks a relay to be authoritative for a number we cannot
  verify. Our counts lag what a relay would report; that is the honest trade.
- **NIP-85 trusted assertions, NIP-66 relay monitors, web-of-trust scores, any
  indexer-derived "trending"** — all are a server's opinion presented as fact.
  Our discovery surfaces state the exact filter they run and never claim a
  popularity score; adopting these would break that contract.
- **NIP-90 DVMs** — outsources translation, search and recommendation to a paid
  third party that sees the query and whose answer cannot be checked.
- **Push notifications** — needs a gateway that reads your subscription list.
  Revisit only in the desktop shell, where the notifier is local.

**Custody in a browser tab.** Cashu wallets, nutzaps, mint discovery, on-chain
zaps. We display ecash tokens and never hold them.

**Sandboxed third-party code** (embedded apps, static sites). On the web the
sandbox is an iframe with a hostile parent relationship, and getting it wrong
exposes the signer. Large surface, no feed value.

**Infrastructure we do not run.** WebRTC calls and audio rooms need STUN/TURN or
a media relay; relay-management APIs are for relay operators.

**Deprecated or discouraged.** Legacy NIP-04 DMs (shipping a known metadata
leak), NIP-26 delegation.

**Vertical apps sharing a transport** — git, calendars, wiki, chess, marketplace,
classifieds, torrents, podcasts, live streams. Setu is a Twitter-shaped reading
client. The correct amount of support is NIP-31 `alt` text plus a NIP-89
"open in…" handler, so an unknown kind is a readable row instead of a blank one.

**Chat and communities.** Named as a top risk in the plan; the shell is
deliberately built so chat could be a clean v2 rather than creeping into v1.

**Proof-of-work mining on the compose path.** Reading a `nonce` is fine. Mining
means burning the user's CPU and battery before every post, and is only worth it
if a relay we actually target demands it.

## 4. Browser-specific limits

Real constraints, not oversights, and the reason a desktop shell is on the plan:

- **NIP-05 verification is CORS-bound.** Many hosts omit
  `Access-Control-Allow-Origin`, so verification cannot complete and those
  handles stay unverified. Native has no such limit.
- **No OS keystore**, hence NIP-49 encryption plus a passphrase prompt rather
  than silent session restore.
- **No background service** — a subscription lives only as long as a tab.
- **No `nostr:` protocol handler** without a native shell.
