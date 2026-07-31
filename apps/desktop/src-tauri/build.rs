fn main() {
    // Reads tauri.conf.json and `capabilities/`, and generates the access-control
    // list the runtime enforces. Without it every `invoke` is rejected at runtime
    // with a permission error that names no cause, because the ACL simply is not
    // there to consult.
    tauri_build::build()
}
