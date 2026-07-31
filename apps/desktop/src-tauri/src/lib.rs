//! The Setu desktop shell.
//!
//! Everything the user sees is the `apps/web` bundle, unmodified. This crate's
//! whole job is to open one window onto it under the security policy declared in
//! `tauri.conf.json` and `capabilities/default.json`.
//!
//! No `#[tauri::command]` is registered, and that is the point rather than an
//! omission. Untrusted note content from arbitrary relays is rendered in this
//! webview next to a signing key; a command that exists is reachable from any
//! script that reaches the page. Native features on the plan (OS keychain,
//! `nostr:` deep links, local notifications) each need one command and one
//! capability entry, added together so a grant is never left without a caller.

/// Entry point shared by the desktop binary and, later, the mobile targets.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // `generate_context!` bakes in tauri.conf.json and the generated ACL at
        // compile time. A config edit therefore needs a rebuild to take effect —
        // editing the CSP and re-running a stale binary shows the old policy.
        .run(tauri::generate_context!())
        // A failure here is the window never opening at all (no webview runtime,
        // a malformed config, a display that cannot be acquired). There is no UI
        // yet in which to report it, so fail loudly on stderr rather than exiting
        // zero and looking like a silent no-op.
        .expect("failed to start the Setu desktop shell");
}
