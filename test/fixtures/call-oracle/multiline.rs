// expected-oracle-calls: 5
fn f() {
    let x = compute
        (1, 2);
    let y = builder()
        .with(1)
        .build();
    g(x, y);
}
