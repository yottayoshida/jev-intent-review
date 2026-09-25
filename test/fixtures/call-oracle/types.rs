// expected-oracle-calls: 1
fn run(f: Box<dyn Fn(u8) -> u8>) -> u8 {
    let g: &dyn Fn(u8) -> u8 = &f;
    g(1)
}
