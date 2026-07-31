# Setu

A Nostr social client for web and desktop. *Setu* is Sanskrit for **bridge**.

- **Local-first.** A local event store is the single source of truth and the app's
  event bus. Relays are writers into it; the UI reads from it. Every signature is
  verified locally, always.
- **Outbox-aware.** Reads about an author go to that author's own write relays
  (NIP-65), expressed as filters bound to a specific relay.
- **Reading-first design.** A calm surface with one accent, a capped reading
  column, and threads that open beside the feed instead of replacing it.

## Quick start

```bash
corepack enable pnpm
pnpm install
pnpm dev            # web app on http://localhost:5273
```

Other commands:

```bash
pnpm verify         # lint + guards + typecheck + test + build
                    # (not `pnpm ci` — that name is a pnpm builtin)
pnpm test           # all package tests
pnpm guards         # px-text, file-size, and layer-import checks
```

Design review screenshots (needs a build + `pnpm preview` running):

```bash
cd apps/web && node scripts/screenshot.mjs --themes setu,dawn
```

## Layout

| Package | Role |
|---|---|
| `packages/protocol` | Wire types, event kinds, id/sign/verify, filters, NIP-19, content tokenizer, signers |
| `packages/core` | Headless client engine: event store, relay pool, subscriptions, feeds. No UI framework. |
| `packages/ui` | Design system: tokens, theme engine, primitives, app shell |
| `apps/web` | Vite + React 19 web app |
| `apps/cli` | Headless consumer of `core` — keeps the layer boundary honest |

The dependency graph is `protocol ← core ← app`, and `ui` imports neither `core`
nor `protocol`. `pnpm check:layers` fails the build if that is violated.

## House rules

1. **No file over 700 lines.** Split it; never raise the limit. God objects start
   as reasonable files and are never split later, because by then it's a project.
2. **No arbitrary text sizes** — px *or* rem. Zoom scales the root font size, so
   px text freezes; arbitrary rem re-fragments the scale. Use a named token.
3. **`core` stays headless.** If a feature can't be exercised from `apps/cli`,
   it's in the wrong layer.
4. **Never skip signature verification.** It is batched off the receive path, not
   optional.

See [`docs/PLAN.md`](docs/PLAN.md) for the full plan and the reasoning behind
these choices, and [`docs/ROADMAP.md`](docs/ROADMAP.md) for the capability
audit — including the list of things we have decided **not** to build, which is
the more useful half.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Third-party attributions,
including the bundled Inter font (SIL OFL 1.1), are in [`NOTICE`](NOTICE).

Re-audit dependency licenses with `pnpm licenses list` after adding any.
