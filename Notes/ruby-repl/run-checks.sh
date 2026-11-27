#!/usr/bin/env bash
# Run all repo checks for the Ruby REPL work and write results to
# Notes/ruby-repl/results.json. Continues past failures; exits nonzero if
# any check failed.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
NOTES="$ROOT/Notes/ruby-repl"
REPORT="$NOTES/report"
CHECKS_DIR="$REPORT/checks"
mkdir -p "$CHECKS_DIR" "$REPORT/scenarios"
rm -f "$REPORT/scenarios/"*.json "$CHECKS_DIR/"*.json

# This machine has no system pkg-config/GTK dev files; use the unpacked
# sysroot under /tmp/rls-sysroot (see Notes for how it was produced).
if [ -d /tmp/rls-sysroot ]; then
    export PATH="/tmp/rls-tools:/tmp/rls-sysroot/usr/bin:$PATH"
    export LD_LIBRARY_PATH="/tmp/rls-sysroot/usr/lib/aarch64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export PKG_CONFIG_PATH="/tmp/rls-sysroot/usr/lib/aarch64-linux-gnu/pkgconfig:/tmp/rls-sysroot/usr/share/pkgconfig"
    export PKG_CONFIG_SYSROOT_DIR="/tmp/rls-sysroot"
fi

now_ms() { ruby -e 'print (Time.now.to_f * 1000).to_i'; }

run_check() {
    local name="$1"; shift
    local logf="$CHECKS_DIR/$name.log"
    local t0=$(now_ms)
    "$@" >"$logf" 2>&1
    local code=$?
    local t1=$(now_ms)
    local cmd="$*"
    NAME="$name" CMD="$cmd" CODE="$code" DUR=$((t1 - t0)) LOGF="$logf" OUTF="$CHECKS_DIR/$name.json" \
    ruby -Eutf-8 -rjson -e '
        log = (File.read(ENV["LOGF"], encoding: "UTF-8") rescue "").scrub
        File.write(ENV["OUTF"], JSON.generate({
            "name" => ENV["NAME"], "command" => ENV["CMD"],
            "exitCode" => ENV["CODE"].to_i, "durationMs" => ENV["DUR"].to_i,
            "tail" => log.lines.last(40).map(&:chomp),
        }))
    '
    echo "[$name] exit=$code $((t1 - t0))ms"
}

run_check vue-tsc   bunx vue-tsc --noEmit
run_check bun-test  bash -c "cd '$ROOT' && RLS_REPORT_DIR='$REPORT' bun test tests/"
run_check cargo-build bash -c "cd '$ROOT/src-tauri' && cargo build"
run_check ruby-session bash -c "cd '$ROOT/src-tauri' && RLS_REPORT_DIR='$REPORT' cargo test --test ruby_session -- --test-threads=4"
run_check cargo-test-lib bash -c "cd '$ROOT/src-tauri' && cargo test --lib"
run_check vite-build bunx vite build

ROOT="$ROOT" NOTES="$NOTES" ruby -Eutf-8 -rjson -e '
    checks = Dir[File.join(ENV["NOTES"], "report/checks/*.json")].sort.map { |f| JSON.parse(File.read(f, encoding: "UTF-8")) }
    scenarios = Dir[File.join(ENV["NOTES"], "report/scenarios/*.json")].sort_by { |f| File.basename(f) }
        .map { |f| JSON.parse(File.read(f, encoding: "UTF-8")) }
    ruby_v = `ruby -v`.strip
    out = {
        "generatedAt" => Time.now.utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ruby" => ruby_v,
        "checks" => checks,
        "scenarios" => scenarios,
    }
    File.write(File.join(ENV["NOTES"], "results.json"), JSON.pretty_generate(out))
    failed = checks.reject { |c| c["exitCode"] == 0 }.map { |c| c["name"] }
    puts "checks: #{checks.count { |c| c["exitCode"] == 0 }}/#{checks.size} ok" + (failed.empty? ? "" : "  FAILED: #{failed.join(", ")}")
    puts "scenarios: #{scenarios.count { |s| s["pass"] }}/#{scenarios.size} pass"
    exit(failed.empty? ? 0 : 1)
'
