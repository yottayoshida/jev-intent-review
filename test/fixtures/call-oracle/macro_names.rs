// expected-oracle-calls: 4
use std::io::Write;
fn f(out: &mut Vec<u8>) {
    out.write(b"x").unwrap();
    let s = format(1);
    println!("{}", s);
    let v = vec![compute(2)];
}
fn format(n: u8) -> String { n.to_string() }
