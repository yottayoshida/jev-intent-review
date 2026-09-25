// expected-oracle-calls: 1
fn live() {
    work();
}
#[cfg(all(test, unix))]
mod platform_tests {
    fn helper() {
        setup();
    }
}
#[test]
fn top_level_test() {
    check();
}
#[cfg(test)]
mod tests;
