// Release builds on Windows must not be linked against the console subsystem, or
// launching Setu from Explorer pops an empty terminal behind the window for the
// life of the process. Debug builds keep the console on purpose: it is where
// webview and Rust-side panics are actually readable.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    setu_desktop_lib::run()
}
