# rls

Tauri + Vue + TypeScript app (bun). Run with `./go`.

## Verification

- All gates + dashboard data: `Notes/ruby-repl/run-checks.sh` (writes `Notes/ruby-repl/results.json`; view `Notes/ruby-repl/index.html` via `python3 -m http.server` in that dir).
- Type-check: `bunx vue-tsc --noEmit`
- TS unit tests (bun:test, outside tsconfig include): `bun test tests/`
- Ruby session tests (real ruby): `cd src-tauri && cargo test --test ruby_session`
- Rust unit tests: `cd src-tauri && cargo test --lib`

## Ruby console

- `src-tauri/ruby/driver.rb` is embedded in the app and runs user code; `src-tauri/src/ruby.rs` owns the process (control socket + nonce markers on stdout/stderr for ordering).
- `src/console.ts` is the pure console state machine; `src/components/RubyConsole.vue` renders it.
- Ruby binary: `RLS_RUBY` env var, else `ruby` on PATH.
