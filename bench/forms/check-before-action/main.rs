// The probe: what each version does with a disabled key, through the entry point a caller uses.
// Built with `rustc --edition 2021 main.rs` next to `auth.rs` (one version) and `store.rs`.

mod auth;
mod store;

use store::{ApiKey, Store};

fn main() {
    let mut store = Store::default();
    let disabled = ApiKey { id: "k-disabled".into(), disabled: true };
    let enabled = ApiKey { id: "k-enabled".into(), disabled: false };
    let d = auth::login(&mut store, &disabled);
    let e = auth::login(&mut store, &enabled);
    // Direct call too: the caller-side version guards only in `login`.
    let direct = auth::open_session(&mut store, &disabled);
    println!(
        "login(disabled)={} login(enabled)={} open_session(disabled)={} sessions={:?}",
        if d.is_ok() { "session" } else { "refused" },
        if e.is_ok() { "session" } else { "refused" },
        if direct.is_ok() { "session" } else { "refused" },
        store.sessions.iter().map(|s| s.key.as_str()).collect::<Vec<_>>()
    );
}
