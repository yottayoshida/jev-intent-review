// expected-oracle-calls: 2
fn r#type() -> u8 { 0 }
fn f() -> u8 {
    let a = r#type();
    a.r#match()
}
