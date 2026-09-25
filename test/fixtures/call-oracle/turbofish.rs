// expected-oracle-calls: 5
fn f() {
    let v = foo::<u8>(1);
    let w = Vec::<u8>::new();
    let c: Vec<u8> = it().collect::<Vec<_>>();
    bar(v, w, c);
}
