// expected-oracle-calls: 3
fn outer() {
    fn inner() {
        deep();
    }
    inner();
    let k = |x: u8| helper(x);
}
