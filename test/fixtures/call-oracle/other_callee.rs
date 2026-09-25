// expected-oracle-calls: 3
struct S { f: fn(u8) -> u8 }
impl S {
    fn go(&self) -> u8 {
        (self.f)(1) + make()(2)
    }
}
fn make() -> fn(u8) -> u8 { id }
fn id(x: u8) -> u8 { x }
