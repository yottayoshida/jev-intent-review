pub fn show(base_dir: &Path) -> Result<(), AppError> {
    let baseline = crate::integrity::read_baseline(base_dir)?;
    Ok(())
}
