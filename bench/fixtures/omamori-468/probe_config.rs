
#[cfg(test)]
mod probe_raw_override_disables {
    use std::path::PathBuf;

    /// What `raw_override_disables` answers when the config path cannot be read as a regular
    /// file — issue #468's shape, and the sentence PR #476 added. Appended to the file in an
    /// isolated clone, never committed to the branches under measurement; the packet is built
    /// from git objects, which do not have it.
    #[test]
    fn probe() {
        let base: PathBuf =
            std::env::temp_dir().join(format!("probe-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("temp base dir");
        let path = base.join("config.toml");

        let absent = super::raw_override_disables(&path, "curl-pipe-sh");
        println!("PROBE nothing planted        -> {absent:?}");

        std::fs::create_dir_all(&path).expect("plant a directory");
        let planted = super::raw_override_disables(&path, "curl-pipe-sh");
        println!("PROBE a directory planted    -> {planted:?}");

        let _ = std::fs::remove_dir_all(&base);
    }
}
