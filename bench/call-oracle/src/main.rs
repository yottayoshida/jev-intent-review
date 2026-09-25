//! The reference list of calls in Rust files, for measuring the listing (#81, docs/call-oracle.md).
//!
//! Usage: `call-oracle <root>` with one path per line on stdin, relative to `<root>`. Writes a JSON
//! array with one entry per path to stdout. A file that does not parse is an entry too, never a gap.
//!
//! Positions are 1-based lines and 0-based columns counted in characters, as `proc-macro2` reports
//! them. A range is `[start line, start column, end line, end column]`, end exclusive.

use std::io::{BufRead, Write};
use std::str::FromStr;

use proc_macro2::{Span, TokenStream, TokenTree};
use serde_json::{json, Value};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, Ident, ImplItem, Item, Lit, Meta, Token, TraitItem};

type Range = [usize; 4];

fn range(span: Span) -> Range {
    let (a, b) = (span.start(), span.end());
    [a.line, a.column, b.line, b.column]
}

/// `r#type` is written `r#type` and called `type`; the listing records the latter.
fn name(ident: &Ident) -> String {
    let text = ident.to_string();
    text.strip_prefix("r#").map(str::to_string).unwrap_or(text)
}

/// Whether a `cfg` predicate can hold only when the tests are compiled. Anything not recognised is
/// not test-only, so the code stays in scope.
fn cfg_test_only(meta: &Meta) -> bool {
    match meta {
        Meta::Path(path) => path.is_ident("test"),
        Meta::List(list) => {
            let parts = match list.parse_args_with(Punctuated::<Meta, Token![,]>::parse_terminated) {
                Ok(parts) => parts,
                Err(_) => return false,
            };
            if list.path.is_ident("all") {
                parts.iter().any(cfg_test_only)
            } else if list.path.is_ident("any") {
                !parts.is_empty() && parts.iter().all(cfg_test_only)
            } else {
                false
            }
        }
        Meta::NameValue(_) => false,
    }
}

/// `#[test]`, `#[tokio::test]`, or a `cfg` that holds only under test.
fn test_only(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        if path.segments.last().is_some_and(|s| s.ident == "test") && !path.is_ident("cfg") {
            return true;
        }
        path.is_ident("cfg") && attr.parse_args::<Meta>().is_ok_and(|m| cfg_test_only(&m))
    })
}

fn item_attrs(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(i) => &i.attrs,
        Item::Enum(i) => &i.attrs,
        Item::ExternCrate(i) => &i.attrs,
        Item::Fn(i) => &i.attrs,
        Item::ForeignMod(i) => &i.attrs,
        Item::Impl(i) => &i.attrs,
        Item::Macro(i) => &i.attrs,
        Item::Mod(i) => &i.attrs,
        Item::Static(i) => &i.attrs,
        Item::Struct(i) => &i.attrs,
        Item::Trait(i) => &i.attrs,
        Item::TraitAlias(i) => &i.attrs,
        Item::Type(i) => &i.attrs,
        Item::Union(i) => &i.attrs,
        Item::Use(i) => &i.attrs,
        _ => &[],
    }
}

#[derive(Default)]
struct Ranges {
    body: Vec<Range>,
    macros: Vec<Range>,
    pattern: Vec<Range>,
    ty: Vec<Range>,
    attribute: Vec<Range>,
    string: Vec<Range>,
    comment: Vec<Range>,
    test_only: Vec<Range>,
}

struct Frame {
    name: String,
    line: usize,
}

#[derive(Default)]
struct Oracle {
    frames: Vec<Frame>,
    fns: Vec<Value>,
    calls: Vec<Value>,
    ranges: Ranges,
    mods: Vec<Value>,
}

impl Oracle {
    /// A `mod name;` whose body is another file. The measurement resolves the file.
    fn declare(&mut self, item: &Item, test: bool) {
        let Item::Mod(module) = item else { return };
        if module.content.is_some() {
            return;
        }
        let path = module.attrs.iter().find(|a| a.path().is_ident("path")).and_then(|a| match &a.meta {
            Meta::NameValue(nv) => match &nv.value {
                Expr::Lit(syn::ExprLit { lit: Lit::Str(s), .. }) => Some(s.value()),
                _ => None,
            },
            _ => None,
        });
        self.mods.push(json!({ "name": name(&module.ident), "path": path, "test": test }));
    }

    fn function(&mut self, ident: &Ident, sig: &syn::Signature, block: &syn::Block) {
        let line = ident.span().start().line;
        self.fns.push(json!({ "name": name(ident), "line": line, "body": range(block.span()) }));
        self.ranges.body.push(range(block.span()));
        self.frames.push(Frame { name: name(ident), line });
        self.visit_signature(sig);
        self.visit_block(block);
        self.frames.pop();
    }

    fn call(&mut self, at: &Ident, callee: String, kind: &str, turbofish: &str, paren: &syn::token::Paren) {
        let Some(frame) = self.frames.last() else { return };
        let (open, close) = (paren.span.open().start(), paren.span.close().start());
        let pos = at.span().start();
        // The listing's column is where the name starts, after an `r#`.
        let column = pos.column + if at.to_string().starts_with("r#") { 2 } else { 0 };
        self.push(frame.name.clone(), frame.line, pos.line, column, callee, name(at), kind, turbofish, open.line != close.line || pos.line != open.line);
    }

    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, fn_name: String, fn_line: usize, line: usize, column: usize, callee: String, last: String, kind: &str, turbofish: &str, multiline: bool) {
        let capitalized = last.chars().next().is_some_and(char::is_uppercase);
        self.calls.push(json!({
            "fn": { "name": fn_name, "line": fn_line },
            "line": line, "column": column, "callee": callee, "last": last,
            "kind": kind, "turbofish": turbofish, "multiline": multiline, "capitalized": capitalized,
        }));
    }
}

impl<'ast> Visit<'ast> for Oracle {
    fn visit_item(&mut self, item: &'ast Item) {
        if test_only(item_attrs(item)) {
            self.ranges.test_only.push(range(item.span()));
            // `#[cfg(test)] mod tests;`: the module is another file, which is test-only too.
            self.declare(item, true);
            return;
        }
        // Every `mod name;` is recorded, test-only or not: a test-only file's own modules are
        // test-only as well, and a `#[path]` changes where a module's children live.
        self.declare(item, false);
        visit::visit_item(self, item);
    }

    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        for attr in &item.attrs {
            self.visit_attribute(attr);
        }
        self.function(&item.sig.ident, &item.sig, &item.block);
    }

    fn visit_impl_item(&mut self, item: &'ast ImplItem) {
        let attrs: &[Attribute] = match item {
            ImplItem::Const(i) => &i.attrs,
            ImplItem::Fn(i) => &i.attrs,
            ImplItem::Type(i) => &i.attrs,
            ImplItem::Macro(i) => &i.attrs,
            _ => &[],
        };
        if test_only(attrs) {
            self.ranges.test_only.push(range(item.span()));
            return;
        }
        visit::visit_impl_item(self, item);
    }

    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        for attr in &item.attrs {
            self.visit_attribute(attr);
        }
        self.function(&item.sig.ident, &item.sig, &item.block);
    }

    fn visit_trait_item(&mut self, item: &'ast TraitItem) {
        let attrs: &[Attribute] = match item {
            TraitItem::Const(i) => &i.attrs,
            TraitItem::Fn(i) => &i.attrs,
            TraitItem::Type(i) => &i.attrs,
            TraitItem::Macro(i) => &i.attrs,
            _ => &[],
        };
        if test_only(attrs) {
            self.ranges.test_only.push(range(item.span()));
            return;
        }
        visit::visit_trait_item(self, item);
    }

    fn visit_trait_item_fn(&mut self, item: &'ast syn::TraitItemFn) {
        for attr in &item.attrs {
            self.visit_attribute(attr);
        }
        match &item.default {
            Some(block) => self.function(&item.sig.ident, &item.sig, block),
            None => self.visit_signature(&item.sig),
        }
    }

    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        match &*call.func {
            Expr::Path(path) if !path.path.segments.is_empty() => {
                let segments = &path.path.segments;
                let last = segments.last().expect("not empty");
                let turbofish = if !last.arguments.is_none() {
                    "last"
                } else if segments.iter().any(|s| !s.arguments.is_none()) {
                    "inner"
                } else {
                    "none"
                };
                let callee = segments.iter().map(|s| name(&s.ident)).collect::<Vec<_>>().join("::");
                self.call(&last.ident, callee, "path", turbofish, &call.paren_token);
            }
            _ => {
                if let Some(frame) = self.frames.last() {
                    let open = call.paren_token.span.open().start();
                    let close = call.paren_token.span.close().start();
                    let (fn_name, fn_line) = (frame.name.clone(), frame.line);
                    self.push(fn_name, fn_line, open.line, open.column, String::new(), String::new(), "other", "none", open.line != close.line);
                }
            }
        }
        visit::visit_expr_call(self, call);
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        let turbofish = if call.turbofish.is_some() { "last" } else { "none" };
        self.call(&call.method, name(&call.method), "method", turbofish, &call.paren_token);
        visit::visit_expr_method_call(self, call);
    }

    // A macro's arguments are tokens until it is expanded: its range is recorded and nothing inside
    // is read (docs/call-oracle.md, *What counts as a call*).
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        self.ranges.macros.push(range(mac.span()));
    }

    fn visit_pat(&mut self, pat: &'ast syn::Pat) {
        self.ranges.pattern.push(range(pat.span()));
        visit::visit_pat(self, pat);
    }

    fn visit_type(&mut self, ty: &'ast syn::Type) {
        self.ranges.ty.push(range(ty.span()));
        visit::visit_type(self, ty);
    }

    // `///` and `/** */` reach the parser as `#[doc = "…"]`; they are comments.
    fn visit_attribute(&mut self, attr: &'ast Attribute) {
        let target = if attr.path().is_ident("doc") { &mut self.ranges.comment } else { &mut self.ranges.attribute };
        target.push(range(attr.span()));
    }

    fn visit_lit(&mut self, lit: &'ast Lit) {
        if matches!(lit, Lit::Str(_) | Lit::ByteStr(_) | Lit::CStr(_) | Lit::Char(_) | Lit::Byte(_)) {
            self.ranges.string.push(range(lit.span()));
        }
    }
}

/// Runs of characters no token covers that hold something other than whitespace: the comments.
fn comments(source: &str) -> Vec<Range> {
    let Ok(stream) = TokenStream::from_str(source) else { return Vec::new() };
    let lines: Vec<Vec<char>> = source.split('\n').map(|l| l.chars().collect()).collect();
    let mut covered: Vec<Vec<bool>> = lines.iter().map(|l| vec![false; l.len() + 1]).collect();
    let mut mark = |span: Span| {
        let (a, b) = (span.start(), span.end());
        for line in a.line..=b.line {
            let Some(row) = covered.get_mut(line - 1) else { continue };
            let from = if line == a.line { a.column } else { 0 };
            let to = if line == b.line { b.column } else { row.len() };
            for cell in row.iter_mut().take(to).skip(from) {
                *cell = true;
            }
        }
    };
    fn walk(stream: TokenStream, mark: &mut dyn FnMut(Span)) {
        for tree in stream {
            match tree {
                TokenTree::Group(group) => {
                    mark(group.span_open());
                    mark(group.span_close());
                    walk(group.stream(), mark);
                }
                other => mark(other.span()),
            }
        }
    }
    walk(stream, &mut mark);

    let mut out = Vec::new();
    let mut open: Option<(usize, usize)> = None;
    let mut last: (usize, usize) = (1, 0);
    for (i, line) in lines.iter().enumerate() {
        for (j, ch) in line.iter().enumerate() {
            if covered[i][j] {
                if let Some(start) = open.take() {
                    out.push([start.0, start.1, last.0, last.1]);
                }
            } else if !ch.is_whitespace() {
                if open.is_none() {
                    open = Some((i + 1, j));
                }
                last = (i + 1, j + 1);
            }
        }
    }
    if let Some(start) = open {
        out.push([start.0, start.1, last.0, last.1]);
    }
    out
}

fn measure(path: &str, source: &str) -> Value {
    let lines = source.split('\n').count();
    let file = match syn::parse_file(source) {
        Ok(file) => file,
        Err(error) => {
            let at = error.span().start();
            return json!({ "path": path, "parsed": false, "lines": lines, "error": format!("{error} ({}:{})", at.line, at.column) });
        }
    };
    let mut oracle = Oracle::default();
    oracle.visit_file(&file);
    let mut r = oracle.ranges;
    r.comment.extend(comments(source));
    json!({
        "path": path, "parsed": true, "lines": lines,
        "fns": oracle.fns, "calls": oracle.calls, "mods": oracle.mods,
        "ranges": {
            "body": r.body, "macro": r.macros, "pattern": r.pattern, "type": r.ty,
            "attribute": r.attribute, "string": r.string, "comment": r.comment, "test_only": r.test_only,
        },
    })
}

fn main() {
    let root = std::env::args().nth(1).expect("usage: call-oracle <root> < paths");
    let mut out = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let path = line.expect("stdin");
        if path.is_empty() {
            continue;
        }
        let full = std::path::Path::new(&root).join(&path);
        let entry = match std::fs::read(&full) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => measure(&path, &text),
                Err(_) => json!({ "path": path, "parsed": false, "lines": 0, "error": "not UTF-8" }),
            },
            Err(error) => json!({ "path": path, "parsed": false, "lines": 0, "error": error.to_string() }),
        };
        out.push(entry);
    }
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer(&mut lock, &out).expect("stdout");
    lock.write_all(b"\n").expect("stdout");
}
