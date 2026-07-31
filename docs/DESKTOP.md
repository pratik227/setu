# Desktop shell

`apps/desktop` is a Tauri 2 shell around **the same `apps/web/dist` output the
browser build produces**. There is no second frontend: `frontendDist` in
`src-tauri/tauri.conf.json` points at `../../web/dist`, and `beforeBuildCommand`
runs `pnpm --filter @setu/web build` to produce it. A UI change lands in both
targets at once, and there is nothing to keep in sync.

The Rust crate opens one window and registers no commands. That is the whole of it.

## Prerequisites

Beyond the repo's Node toolchain, the desktop target needs a **Rust toolchain**
(`cargo`, `rustc`) plus the platform webview dependencies — Xcode command line
tools on macOS, WebView2 and MSVC on Windows, `libwebkit2gtk-4.1-dev` and friends
on Linux. See Tauri's prerequisites page for the current package lists.

CI does **not** build this app, and `pnpm run verify` deliberately does not touch
it. Adding it would put a Rust toolchain and three platform SDKs on the critical
path of every pull request that changes a stylesheet.

## Scripts

```
pnpm --filter @setu/desktop dev     # Vite dev server + native window, hot reload
pnpm --filter @setu/desktop build   # web build, then a native bundle
```

`pnpm dev:desktop` and `pnpm build:desktop` at the root are aliases.

`dev` starts the web dev server with `--strictPort`. Without it Vite silently
moves to the next free port when 5273 is busy, and the native window then points
at a `devUrl` nothing is listening on — a blank window with no error anywhere.

## Security posture

The app holds a signing key and renders untrusted note content from arbitrary
relays. Every capability it does not need is surface it should not have, so the
starting point here is "nothing", not Tauri's defaults.

| Setting | Value | Why |
|---|---|---|
| `capabilities/default.json` permissions | `[]` | The shared frontend calls no Tauri command, so `core:default` — which `tauri init` writes, granting window, path, event, tray, menu and resource commands — would be a bridge with no caller. A script that reaches the page must find nothing waiting for it. |
| Tauri plugins | none | No `-fs`, `-shell`, `-process`, `-http`, `-dialog`, `-opener`. A compiled-in plugin is reachable surface even before a capability grants a command. Relay WebSockets, media fetches, NIP-05 lookups and NIP-96 uploads are all made by the webview itself, so none of these buys any functionality. |
| `withGlobalTauri` | `false` | `window.__TAURI__` would hand injected script the whole API surface. Nothing in the frontend reads it. |
| `assetProtocol.enable` | `false` | The asset protocol exists to read arbitrary local files into the webview. There is no filesystem feature, so there is no reason to open the door. |
| `freezePrototype` | `true` | Relay JSON is parsed continuously; freezing `Object.prototype` closes the prototype-pollution route into that parsing. Verified not to break the real app (see below). |
| `dragDropEnabled` | `false` | Tauri's OS-level drag-drop handler swallows the event and emits a Tauri one instead. Nothing listens for that, so an image dropped on the compose box would silently vanish. `false` leaves HTML5 drop working, which is what the shared frontend uses. |
| `csp` | see below | |

The CSP mirrors the one served by `netlify.toml`, for the same reasons documented
there, with two Tauri-specific differences:

- `connect-src` gains `ipc: http://ipc.localhost`. Those are the two shapes
  Tauri's IPC transport takes off macOS — a custom `ipc://` scheme on Linux, an
  `http://ipc.localhost` fetch on Windows. macOS goes through a WebKit message
  handler and needs no CSP allowance at all, which is the trap: drop these and
  everything still works on the machine you tested, then the first native command
  fails closed on the other two platforms.
- `script-src 'self'` and `style-src` need no hashes or `'unsafe-inline'` for
  Tauri's own injected bootstrap. Tauri rewrites those two directives with a
  per-load nonce at runtime (`__TAURI_SCRIPT_NONCE__` is substituted into the
  policy before the header is sent). A hardcoded hash here would drift out of
  date and fail closed on a Tauri bump.

`index.html` loads `/theme-init.js` as a plain, non-deferred external script, and
that has to keep resolving or every launch flashes the wrong background. It does:
the compiled binary embeds the asset under the key `/theme-init.js`, which is
exactly the path the tag requests, and the file is served by the asset protocol
from the `frontendDist` root.

One caveat worth knowing before debugging a CSP problem: **the CSP is only
enforced in a built app.** In `tauri dev` the page is served by Vite over plain
HTTP, so Tauri cannot attach the header. Reproduce CSP behaviour with
`tauri build --debug`, not with `tauri dev`.

The isolation pattern was considered and left off. It interposes a sandboxed
frame between the frontend and the IPC layer, and with no commands registered
there is nothing for it to interpose on. Revisit it together with the first
native command.

## What a maintainer must still supply

The scaffold builds and runs. It cannot yet ship, and none of the following can
live in this repository:

- **macOS signing and notarization.** An Apple Developer ID Application
  certificate in the build keychain, plus `APPLE_ID`, `APPLE_PASSWORD` (an
  app-specific password) and `APPLE_TEAM_ID` in the environment. Without them
  `tauri build` produces an ad-hoc, linker-signed bundle that Gatekeeper refuses
  on any machine but the one that built it. `bundle.macOS.signingIdentity`
  selects the certificate.
- **Windows signing.** An Authenticode certificate, referenced through
  `bundle.windows.certificateThumbprint` (or the Azure Trusted Signing settings).
  Unsigned installers get a SmartScreen warning.
- **Auto-update.** `bundle.createUpdaterArtifacts` is `false` because the updater
  needs three things this repo has none of: a minisign keypair (`tauri signer
  generate`) with the private half held as a secret and the public half in
  `plugins.updater.pubkey`, an HTTPS endpoint serving the update manifest, and
  the `tauri-plugin-updater` dependency and its capability entry. The plugin is
  deliberately absent rather than present-and-misconfigured — a shipped updater
  pointing at nothing is worse than no updater.
- **A real version.** `version` in `tauri.conf.json` is `0.0.0`. It drives the
  bundle version on every platform and the updater's comparison, so it must
  start tracking releases before the first one.
- **An app icon that is an app icon.** `src-tauri/icons/` is generated from
  `apps/web/public/favicon.svg`, which was drawn for a 16px browser tab.
  Regenerate with `pnpm --filter @setu/desktop exec tauri icon <1024px.png>` once
  a real icon exists.

## Native features on the plan

Each of these needs one command and one capability entry, added together so a
grant never outlives its caller: OS keychain storage for the signing key,
server-side NIP-05 verification (browsers cannot complete it against hosts that
omit CORS headers), a `nostr:` protocol handler, local notifications, and window
vibrancy.
