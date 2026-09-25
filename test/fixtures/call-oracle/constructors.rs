// expected-oracle-calls: 4
enum E { A(u8), B }
fn f(e: E) -> Result<u8, ()> {
    let n = match e {
        E::A(n) => n,
        E::B => zero(),
    };
    let w = E::A(n);
    drop(w);
    Ok(n)
}
fn zero() -> u8 { 0 }
