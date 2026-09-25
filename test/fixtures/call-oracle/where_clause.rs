// expected-oracle-calls: 2
fn generic<T>(x: T) -> u8
where
    T: Into<u8>,
{
    let v = x.into();
    add(v)
}
