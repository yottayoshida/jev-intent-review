use std::path::Path;

/// Read existing baseline from disk.
pub fn read_baseline(base_dir: &Path) -> Result<Option<Baseline>, AppError> {
    let path = baseline_path(base_dir);
    if !path.exists() {
        return Ok(None);
    }
    let Ok(content) = crate::atomic_file::read_capped(&path, MAX) else { return Ok(None) };
    Ok(Some(content))
}

fn baseline_path(base_dir: &Path) -> PathBuf {
    base_dir.join(".integrity.json")
}
