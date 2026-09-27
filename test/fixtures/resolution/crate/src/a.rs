pub fn load(p: &str) -> Result<String, std::io::Error> {
    std::fs::read_to_string(p)
}
