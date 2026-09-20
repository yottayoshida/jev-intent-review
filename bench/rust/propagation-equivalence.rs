// The two code versions the stated-condition experiment asks about, and a test that they are the
// same function.
//
//   rustc --test bench/rust/propagation-equivalence.rs -o /tmp/eq && /tmp/eq
//
// `implicit` is the read loop as `show_entries` ships it: `let line = line?;`. `explicit` spells
// the same thing out as `match` + `return Err(...)`. The experiment asks Jev what each returns when
// the iterator yields an error, so the whole experiment is void unless they return the same thing
// for the same input — that is what `cases()` below checks, over inputs that put the error first,
// last, in the middle, next to a line that will not parse, and nowhere at all.
//
// `AuditEvent` here is a line that parses, and "parses" is `!line.starts_with("junk")` — the real
// `serde_json::from_str` is not the subject and a second parser would only add a way to differ.

use std::collections::VecDeque;
use std::io::{Error, ErrorKind, Result as IoResult};

#[derive(Debug, PartialEq, Eq)]
enum AuditError {
    Io(String),
}

impl From<Error> for AuditError {
    fn from(e: Error) -> Self {
        AuditError::Io(e.to_string())
    }
}

type AuditEvent = String;

fn parse(trimmed: &str) -> Option<AuditEvent> {
    if trimmed.starts_with("junk") {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// As shipped: the read failure goes back to the caller through `?`.
fn implicit(
    lines: impl Iterator<Item = IoResult<String>>,
) -> Result<VecDeque<AuditEvent>, AuditError> {
    let mut entries: VecDeque<AuditEvent> = VecDeque::new();
    for line in lines {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event: AuditEvent = match parse(trimmed) {
            Some(e) => e,
            None => continue,
        };
        entries.push_back(event);
    }
    Ok(entries)
}

/// The same, with the return written out.
fn explicit(
    lines: impl Iterator<Item = IoResult<String>>,
) -> Result<VecDeque<AuditEvent>, AuditError> {
    let mut entries: VecDeque<AuditEvent> = VecDeque::new();
    for line in lines {
        let line = match line {
            Ok(l) => l,
            Err(e) => return Err(AuditError::from(e)),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event: AuditEvent = match parse(trimmed) {
            Some(e) => e,
            None => continue,
        };
        entries.push_back(event);
    }
    Ok(entries)
}

#[cfg(test)]
fn ok(s: &str) -> IoResult<String> {
    Ok(s.to_string())
}

#[cfg(test)]
fn err(msg: &str) -> IoResult<String> {
    Err(Error::new(ErrorKind::InvalidData, msg.to_string()))
}

#[cfg(test)]
fn cases() -> Vec<(&'static str, Vec<IoResult<String>>)> {
    vec![
        ("empty iterator", vec![]),
        ("no error at all", vec![ok("a"), ok("b")]),
        ("error first", vec![err("boom"), ok("a")]),
        ("error in the middle", vec![ok("a"), err("boom"), ok("b")]),
        ("error last", vec![ok("a"), ok("b"), err("boom")]),
        ("only an error", vec![err("boom")]),
        ("blank lines around the error", vec![ok("  "), err("boom"), ok("")]),
        ("unparsable line before the error", vec![ok("junk1"), err("boom"), ok("a")]),
        ("unparsable line after the error", vec![ok("a"), err("boom"), ok("junk2")]),
        ("unparsable lines and no error", vec![ok("a"), ok("junk1"), ok("b")]),
        ("two errors", vec![ok("a"), err("first"), err("second")]),
    ]
}

#[test]
fn the_two_versions_return_the_same_thing() {
    for (name, input) in cases() {
        let a = implicit(input.iter().map(|r| match r {
            Ok(s) => Ok(s.clone()),
            Err(e) => Err(Error::new(e.kind(), e.to_string())),
        }));
        let b = explicit(input.iter().map(|r| match r {
            Ok(s) => Ok(s.clone()),
            Err(e) => Err(Error::new(e.kind(), e.to_string())),
        }));
        assert_eq!(a, b, "the two versions differ on: {name}");
    }
}

/// The control for the test above: a version that really does differ has to make it fail, or the
/// comparison is passing because both sides are wrong in the same way, or not running at all.
#[cfg(test)]
fn skips_unreadable(
    lines: impl Iterator<Item = IoResult<String>>,
) -> Result<VecDeque<AuditEvent>, AuditError> {
    let mut entries: VecDeque<AuditEvent> = VecDeque::new();
    for line in lines {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event: AuditEvent = match parse(trimmed) {
            Some(e) => e,
            None => continue,
        };
        entries.push_back(event);
    }
    Ok(entries)
}

#[test]
fn a_version_that_differs_is_caught() {
    let mut differed = 0;
    for (_, input) in cases() {
        let a = implicit(input.iter().map(|r| match r {
            Ok(s) => Ok(s.clone()),
            Err(e) => Err(Error::new(e.kind(), e.to_string())),
        }));
        let c = skips_unreadable(input.iter().map(|r| match r {
            Ok(s) => Ok(s.clone()),
            Err(e) => Err(Error::new(e.kind(), e.to_string())),
        }));
        if a != c {
            differed += 1;
        }
    }
    // The eight inputs that contain an error; the three that do not (empty, no error at all,
    // unparsable lines and no error) must NOT separate them. An exact count rather than
    // `differed > 0`, because that would also pass if only one input did any work.
    assert_eq!(
        differed, 8,
        "every input that contains an error must separate the violation from the shipped loop"
    );
}
