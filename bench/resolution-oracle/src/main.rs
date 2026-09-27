//! What each name in a Rust repository refers to, read from rust-analyzer's SCIP index, for
//! measuring the product's name resolution (#83, docs/resolution.md).
//!
//! Usage: `resolution-oracle <repo root> <index.scip>...`. A repository with no manifest at its root
//! is indexed once per Cargo project; each index names its own project root, and paths are rewritten
//! to be relative to `<repo root>`. Writes one JSON object to stdout.
//!
//! Positions are 1-based lines and 0-based columns in UTF-16 code units, as the product counts them.
//! SCIP counts columns in the encoding each document declares; rust-analyzer declares UTF-8.
//!
//! Output:
//!   symbols: [[symbol, kind]]                           kind is "" when the index gives none
//!                                                       (every symbol defined outside the repository)
//!   defs:    [[symbol id, path, line, start, end]]      a definition's name line and the lines of
//!                                                       the item it names
//!   refs:    {path: [[line, column, [symbol id…]]]}     every place a name is used and not defined
//!   files:   {path: bytes}                              the documents the indexes hold

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use protobuf::Message;
use scip::types::{Index, PositionEncoding};
use serde_json::{json, Value};

/// A UTF-8 column on a line, in UTF-16 code units. `None` when the column is not a character
/// boundary of the line as the file has it: the index and the file disagree.
fn utf16_column(line: &str, utf8: usize) -> Option<usize> {
    line.get(..utf8).map(|prefix| prefix.encode_utf16().count())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: resolution-oracle <repo root> <index.scip>...");
        std::process::exit(2);
    }
    let root = Path::new(&args[1]).canonicalize().expect("repo root");

    let mut ids: HashMap<String, usize> = HashMap::new();
    let mut symbols: Vec<(String, String)> = Vec::new();
    let mut intern = |symbol: &str, kind: Option<String>, symbols: &mut Vec<(String, String)>| -> usize {
        let id = *ids.entry(symbol.to_string()).or_insert_with(|| {
            symbols.push((symbol.to_string(), String::new()));
            symbols.len() - 1
        });
        if let Some(kind) = kind {
            if symbols[id].1.is_empty() {
                symbols[id].1 = kind;
            }
        }
        id
    };
    let mut defs: Vec<Value> = Vec::new();
    let mut refs: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut files: BTreeMap<String, usize> = BTreeMap::new();
    let mut indexes: Vec<Value> = Vec::new();
    let mut tool = String::new();
    let mut misaligned = 0usize;

    for file in &args[2..] {
        let index = Index::parse_from_bytes(&std::fs::read(file).expect("read index")).expect("parse index");
        tool = format!("{} {}", index.metadata.tool_info.name, index.metadata.tool_info.version);
        let project = index.metadata.project_root.strip_prefix("file://").unwrap_or(&index.metadata.project_root).to_string();
        let project = Path::new(&project).canonicalize().expect("project root");
        let prefix = project.strip_prefix(&root).expect("each index's project root is inside the repo root").to_path_buf();
        indexes.push(json!({ "file": Path::new(file).file_name().unwrap().to_string_lossy(), "prefix": prefix.to_string_lossy(), "documents": index.documents.len() }));

        for doc in &index.documents {
            if doc.position_encoding.enum_value_or_default() != PositionEncoding::UTF8CodeUnitOffsetFromLineStart {
                panic!("{}: position encoding {:?}, not UTF-8", doc.relative_path, doc.position_encoding);
            }
            let path = prefix.join(&doc.relative_path).to_string_lossy().to_string();
            let text = std::fs::read_to_string(root.join(&path)).unwrap_or_default();
            files.insert(path.clone(), text.len());
            let lines: Vec<&str> = text.split('\n').collect();

            for info in &doc.symbols {
                intern(&info.symbol, Some(format!("{:?}", info.kind.enum_value_or_default())), &mut symbols);
            }
            // Several symbols can sit on one range (a struct field written in shorthand is a local and a
            // field); they are kept together and the reader decides.
            let mut here: BTreeMap<(i32, i32), Vec<usize>> = BTreeMap::new();
            for occ in &doc.occurrences {
                let id = intern(&occ.symbol, None, &mut symbols);
                let (line, col) = (occ.range[0], occ.range[1]);
                if occ.symbol_roles & 1 == 1 {
                    let enclosing = if occ.enclosing_range.is_empty() { &occ.range } else { &occ.enclosing_range };
                    let end = if enclosing.len() == 4 { enclosing[2] } else { enclosing[0] };
                    defs.push(json!([id, path, line + 1, enclosing[0] + 1, end + 1]));
                } else {
                    here.entry((line, col)).or_default().push(id);
                }
            }
            let out = refs.entry(path.clone()).or_default();
            for ((line, col), mut at) in here {
                let Some(column) = lines.get(line as usize).and_then(|l| utf16_column(l, col as usize)) else {
                    misaligned += 1;
                    continue;
                };
                at.sort_unstable();
                at.dedup();
                out.push(json!([line + 1, column, at]));
            }
        }
    }

    let symbols: Vec<Value> = symbols.into_iter().map(|(s, k)| json!([s, k])).collect();
    println!("{}", json!({ "tool": tool, "indexes": indexes, "misaligned": misaligned, "files": files, "symbols": symbols, "defs": defs, "refs": refs }));
}

#[cfg(test)]
mod tests {
    use super::utf16_column;

    #[test]
    fn columns_count_utf16_units() {
        // "é" is two UTF-8 bytes and one UTF-16 unit; "𝄞" is four bytes and two units.
        assert_eq!(utf16_column("aé.f()", 3), Some(2));
        assert_eq!(utf16_column("𝄞.f()", 5), Some(3));
        assert_eq!(utf16_column("aé", 2), None);
    }
}
