# vendor

`tree-sitter-rust.wasm` is the Rust grammar the listing of a Rust file's functions and calls is read
with (`src/syntax/rust.ts`, ADR 0022). It is loaded by `web-tree-sitter`, a dependency, so installing
this package builds nothing native.

| File | From |
|---|---|
| `tree-sitter-rust.wasm` | the npm package `tree-sitter-rust@0.24.0`, file `tree-sitter-rust.wasm`, unchanged |
| `LICENSE-tree-sitter-rust` | the same package's `LICENSE` (MIT) |

The package's tarball matched the registry (`dist.shasum` `efe9104052ae022e98d2cd30018587bd05ce01f3`,
`dist.integrity` `sha512-NWemUDf629Tfc90Y0Z55zuwPCAHkLxWnMf2RznYu4iBkkrQl2o/CHGB7Cr52TyN5F1DAx8FmUnDtCy9iUkXZEQ==`)
when the file was taken. The file itself:

```
sha256 f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57  tree-sitter-rust.wasm
```

`test/syntax-rust.test.ts` checks that sha256, so a replaced grammar fails the tests until this table
and the fixtures' baseline are written again. To take a newer grammar: `npm pack tree-sitter-rust@<v>`,
check the tarball against `npm view tree-sitter-rust@<v> dist.integrity`, copy the `.wasm` and the
`LICENSE`, and update this file.
