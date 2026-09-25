// expected-oracle-calls: 2
fn f() {
    /* legacy: old_call(x) */
    real();
    let s = "not_a_call(1)";
    // line_comment(2)
    other(s); // trailing_note(3)
}
