use rls_lib::ruby::{RubyEvent, Session, SessionConfig};
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

const SPAWN_WAIT: Duration = Duration::from_secs(15);
const RESULT_WAIT: Duration = Duration::from_secs(10);

struct Rig {
    session: Session,
    rx: Receiver<(u64, Value)>,
    start: Instant,
    transcript: Vec<Value>,
    events: Vec<(u64, Value)>,
}

fn detail(ev: &Value) -> String {
    match ev.get("type").and_then(|t| t.as_str()) {
        Some("output") => {
            let stream = ev.get("stream").and_then(|s| s.as_str()).unwrap_or("?");
            let text = ev.get("text").and_then(|s| s.as_str()).unwrap_or("");
            let truncated: String = text.chars().take(300).collect();
            if text.len() > 300 {
                format!("output[{stream}] {truncated:?} (+{} chars total)", text.len())
            } else {
                format!("output[{stream}] {truncated:?}")
            }
        }
        _ => ev.to_string(),
    }
}

fn drain_until<F>(rig: &mut Rig, pred: F, timeout: Duration) -> bool
where
    F: Fn(&Value) -> bool,
{
    if rig.events.iter().any(|(_, ev)| pred(ev)) {
        return true;
    }
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        match rig.rx.recv_timeout(left.min(Duration::from_millis(50))) {
            Ok((t, ev)) => {
                let matched = pred(&ev);
                rig.transcript.push(json!({
                    "tMs": t,
                    "dir": "out",
                    "kind": ev.get("type").and_then(|s| s.as_str()).unwrap_or("?"),
                    "detail": detail(&ev),
                }));
                rig.events.push((t, ev));
                if matched {
                    return true;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
}

fn is_started(ev: &Value) -> bool {
    ev.get("type").and_then(|t| t.as_str()) == Some("started")
}

fn is_result(ev: &Value) -> bool {
    ev.get("type").and_then(|t| t.as_str()) == Some("result")
}

fn result_for(ev: &Value, id: u64) -> bool {
    is_result(ev) && ev.get("id").and_then(|v| v.as_u64()) == Some(id)
}

fn spawn_rig_with(cfg: SessionConfig) -> Rig {
    let (tx, rx) = channel();
    let start = Instant::now();
    let t0 = start;
    let sink = Arc::new(move |ev: RubyEvent| {
        let _ = tx.send((
            t0.elapsed().as_millis() as u64,
            serde_json::to_value(&ev).unwrap(),
        ));
    });
    let session = Session::spawn(cfg, sink).expect("spawn ruby session");
    let mut rig = Rig {
        session,
        rx,
        start,
        transcript: Vec::new(),
        events: Vec::new(),
    };
    drain_until(&mut rig, is_started, SPAWN_WAIT);
    rig
}

fn eval_and_wait(rig: &mut Rig, code: &str) -> Option<Value> {
    rig.transcript.push(json!({
        "tMs": rig.start.elapsed().as_millis() as u64,
        "dir": "in",
        "kind": "eval",
        "detail": format!("{code:?}"),
    }));
    let id = match rig.session.eval(code) {
        Ok(id) => id,
        Err(e) => {
            rig.transcript.push(json!({
                "tMs": rig.start.elapsed().as_millis() as u64,
                "dir": "out",
                "kind": "eval-error",
                "detail": e,
            }));
            return None;
        }
    };
    drain_until(rig, |ev| result_for(ev, id), RESULT_WAIT);
    rig.events
        .iter()
        .find(|(_, ev)| result_for(ev, id))
        .map(|(_, ev)| ev.clone())
}

fn eval_value(rig: &mut Rig, code: &str) -> Option<String> {
    let ev = eval_and_wait(rig, code)?;
    Some(
        ev.get("value")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    )
}

fn run_check(rig: &mut Rig, code: &str) -> Result<bool, String> {
    rig.transcript.push(json!({
        "tMs": rig.start.elapsed().as_millis() as u64,
        "dir": "in",
        "kind": "check",
        "detail": format!("{code:?}"),
    }));
    let r = rig.session.check(code);
    rig.transcript.push(json!({
        "tMs": rig.start.elapsed().as_millis() as u64,
        "dir": "out",
        "kind": "check-reply",
        "detail": format!("{r:?}"),
    }));
    r
}

fn write_report(
    id: &str,
    criterion: &str,
    title: &str,
    expect: &str,
    start: Instant,
    metric: Option<Value>,
    transcript: &[Value],
    failure: Option<&str>,
) {
    let report = json!({
        "id": id,
        "criterion": criterion,
        "title": title,
        "expect": expect,
        "pass": failure.is_none(),
        "durationMs": start.elapsed().as_millis() as u64,
        "metric": metric,
        "transcript": transcript,
        "failure": failure,
    });
    if let Ok(dir) = std::env::var("RLS_REPORT_DIR") {
        let scenarios = std::path::Path::new(&dir).join("scenarios");
        let _ = std::fs::create_dir_all(&scenarios);
        let _ = std::fs::write(
            scenarios.join(format!("{id}.json")),
            serde_json::to_string_pretty(&report).unwrap(),
        );
    }
}

struct Scn {
    id: &'static str,
    criterion: &'static str,
    title: &'static str,
    expect: &'static str,
    start: Instant,
    rig: Option<Rig>,
    transcript: Vec<Value>,
    failures: Vec<String>,
    metric: Option<Value>,
}

impl Scn {
    fn new(
        id: &'static str,
        criterion: &'static str,
        title: &'static str,
        expect: &'static str,
    ) -> Self {
        Self {
            id,
            criterion,
            title,
            expect,
            start: Instant::now(),
            rig: None,
            transcript: Vec::new(),
            failures: Vec::new(),
            metric: None,
        }
    }

    fn record(&mut self, kind: &str, detail: String) {
        self.transcript.push(json!({
            "tMs": self.start.elapsed().as_millis() as u64,
            "dir": "in",
            "kind": kind,
            "detail": detail,
        }));
    }

    fn rig(&mut self) -> &mut Rig {
        if self.rig.is_none() {
            self.rig = Some(spawn_rig_with(SessionConfig::default()));
        }
        self.rig.as_mut().unwrap()
    }

    fn eval_and_wait(&mut self, code: &str) -> Option<Value> {
        eval_and_wait(self.rig(), code)
    }

    fn eval_value(&mut self, code: &str) -> Option<String> {
        eval_value(self.rig(), code)
    }

    fn run_check(&mut self, code: &str) -> Result<bool, String> {
        run_check(self.rig(), code)
    }

    fn eval_id(&mut self, code: &str) -> u64 {
        let rig = self.rig();
        rig.transcript.push(json!({
            "tMs": rig.start.elapsed().as_millis() as u64,
            "dir": "in",
            "kind": "eval",
            "detail": format!("{code:?}"),
        }));
        rig.session.eval(code).expect("eval")
    }

    fn try_eval(&mut self, code: &str) -> Result<u64, String> {
        let rig = self.rig();
        rig.transcript.push(json!({
            "tMs": rig.start.elapsed().as_millis() as u64,
            "dir": "in",
            "kind": "eval",
            "detail": format!("{code:?}"),
        }));
        rig.session.eval(code)
    }

    fn stdin(&mut self, text: &str) {
        let rig = self.rig();
        rig.transcript.push(json!({
            "tMs": rig.start.elapsed().as_millis() as u64,
            "dir": "in",
            "kind": "stdin",
            "detail": format!("{text:?}"),
        }));
        rig.session.stdin(text).expect("stdin");
    }

    fn interrupt(&mut self) -> &'static str {
        self.record("interrupt", "ctrl-c".to_string());
        self.rig().session.interrupt()
    }

    fn drain<F: Fn(&Value) -> bool>(&mut self, pred: F, timeout: Duration) -> bool {
        drain_until(self.rig(), pred, timeout)
    }

    fn events_where<F: Fn(&Value) -> bool>(&mut self, pred: F) -> Vec<Value> {
        self.rig()
            .events
            .iter()
            .filter(|(_, ev)| pred(ev))
            .map(|(_, ev)| ev.clone())
            .collect()
    }

    fn first_result(&mut self, id: u64) -> Option<Value> {
        self.events_where(|ev| result_for(ev, id)).into_iter().next()
    }

    fn output_text(&mut self, stream: &str) -> String {
        self.events_where(|ev| {
            ev.get("type").and_then(|t| t.as_str()) == Some("output")
                && ev.get("stream").and_then(|s| s.as_str()) == Some(stream)
        })
        .iter()
        .map(|ev| {
            ev.get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect()
    }

    fn check(&mut self, ok: bool, what: impl Into<String>) {
        if !ok {
            self.failures.push(what.into());
        }
    }

    fn expect_eq<T: PartialEq + std::fmt::Debug>(&mut self, got: T, want: T, what: &str) {
        if got != want {
            self.failures
                .push(format!("{what}: got {got:?}, want {want:?}"));
        }
    }

    fn metric(&mut self, name: &str, value: u64, unit: &str, limit: u64) {
        self.metric =
            Some(json!({"name": name, "value": value, "unit": unit, "limit": limit}));
    }

    fn finish(self) {
        let mut transcript = self.transcript.clone();
        if let Some(rig) = &self.rig {
            transcript.extend(rig.transcript.iter().cloned());
        }
        transcript.sort_by_key(|e| e.get("tMs").and_then(|v| v.as_u64()).unwrap_or(0));
        let failure = if self.failures.is_empty() {
            None
        } else {
            Some(self.failures.join("; "))
        };
        write_report(
            self.id,
            self.criterion,
            self.title,
            self.expect,
            self.start,
            self.metric,
            &transcript,
            failure.as_deref(),
        );
        assert!(self.failures.is_empty(), "{}", self.failures.join("; "));
    }
}

fn snap_entries(ev: &Value, area: &str) -> Vec<(String, String)> {
    ev.get("snapshot")
        .and_then(|s| s.get(area))
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .map(|e| {
                    (
                        e.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        e.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn status_of(ev: &Value) -> Option<String> {
    ev.get("status").and_then(|v| v.as_str()).map(str::to_owned)
}

fn field_str(ev: &Value, key: &str) -> Option<String> {
    ev.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

// ---------- S3 completeness cases ----------

fn check_case(id: &'static str, code: &str, want: bool) {
    let mut scn = Scn::new(id, "S3", "code completeness check", "complete matches expectation");
    match scn.run_check(code) {
        Ok(g) => scn.check(g == want, format!("check({code:?}) = {g}, want {want}")),
        Err(e) => scn.check(false, format!("check({code:?}) errored: {e}")),
    }
    scn.finish();
}

#[test] fn k01() { check_case("K01", "def f\n", false) }
#[test] fn k02() { check_case("K02", "def f\n  1\nend\n", true) }
#[test] fn k03() { check_case("K03", "1 +* 2\n", true) }
#[test] fn k04() { check_case("K04", "end\n", true) }
#[test] fn k05() { check_case("K05", "[1,\n", false) }
#[test] fn k06() { check_case("K06", "foo(\n", false) }
#[test] fn k07() { check_case("K07", "x = \"abc\n", false) }
#[test] fn k08() { check_case("K08", "1 +\n", false) }
#[test] fn k09() { check_case("K09", "if x\n", false) }
#[test] fn k10() { check_case("K10", "class A; def b\n", false) }
#[test] fn k11() { check_case("K11", "<<~E\nhi\n", false) }
#[test] fn k12() { check_case("K12", "1)\n", true) }
#[test] fn k13() { check_case("K13", "def f\n  1 +* 2\n", false) }
#[test] fn k14() { check_case("K14", "{a: \n", false) }
#[test] fn k15() { check_case("K15", "puts 'hi' if\n", false) }
#[test] fn k16() { check_case("K16", "x = 1 \\\n", false) }
#[test] fn k17() { check_case("K17", "=begin\n", false) }
#[test] fn k18() { check_case("K18", "foo do |x|\n", false) }
#[test] fn k19() { check_case("K19", "%w[a b\n", false) }
#[test] fn k20() { check_case("K20", "1 + 2\nend\n", true) }
#[test] fn k21() { check_case("K21", "x.\n", false) }
#[test] fn k22() { check_case("K22", "foo\n  .bar\n", true) }
#[test] fn k23() { check_case("K23", "1 +\n2\n", true) }
#[test] fn k24() { check_case("K24", "def f(\n", false) }
#[test] fn k25() { check_case("K25", "[1,2]]\n", true) }
#[test] fn k26() { check_case("K26", "p 1\n", true) }

// ---------- Eval scenarios ----------

#[test]
fn e01_basic_eval() {
    let mut scn = Scn::new("E01", "S1", "evaluates an expression", "1 + 2 => ok \"3\"");
    let v = scn.eval_value("1 + 2");
    scn.expect_eq(v, Some("3".to_string()), "1 + 2");
    scn.finish();
}

#[test]
fn e02_state_persists() {
    let mut scn = Scn::new("E02", "S2", "locals, methods and classes persist", "x+1 => 42, sq(7) => 49, Foo.new.hi => \"hi\"");
    scn.eval_and_wait("x = 41");
    let v = scn.eval_value("x + 1");
    scn.expect_eq(v, Some("42".to_string()), "x + 1");
    let v = scn.eval_value("def sq(n) = n * n");
    scn.expect_eq(v, Some(":sq".to_string()), "def sq");
    let v = scn.eval_value("sq(7)");
    scn.expect_eq(v, Some("49".to_string()), "sq(7)");
    scn.eval_and_wait("class Foo; def hi = \"hi\"; end");
    let v = scn.eval_value("Foo.new.hi");
    scn.expect_eq(v, Some("\"hi\"".to_string()), "Foo.new.hi");
    scn.finish();
}

#[test]
fn e03_multiline_check_and_eval() {
    let mut scn = Scn::new("E03", "S3", "incremental completeness then eval", "incomplete until end, then works");
    let r1 = scn.run_check("def add(a, b)\n");
    scn.expect_eq(r1, Ok(false), "check 1");
    let r2 = scn.run_check("def add(a, b)\n  a + b\n");
    scn.expect_eq(r2, Ok(false), "check 2");
    let r3 = scn.run_check("def add(a, b)\n  a + b\nend\n");
    scn.expect_eq(r3, Ok(true), "check 3");
    let v = scn.eval_value("def add(a, b)\n  a + b\nend");
    scn.expect_eq(v, Some(":add".to_string()), "def add");
    let v = scn.eval_value("add(2, 3)");
    scn.expect_eq(v, Some("5".to_string()), "add(2, 3)");
    scn.finish();
}

#[test]
fn e04_syntax_error() {
    let mut scn = Scn::new("E04", "S4", "syntax error reported, session survives", "SyntaxError with syntax flag");
    let ev = scn.eval_and_wait("1 +* 2");
    match &ev {
        Some(ev) => {
            scn.expect_eq(status_of(ev), Some("error".to_string()), "status");
            scn.expect_eq(field_str(ev, "class"), Some("SyntaxError".to_string()), "class");
            scn.expect_eq(ev.get("syntax").and_then(|v| v.as_bool()), Some(true), "syntax");
            let msg = field_str(ev, "message").unwrap_or_default();
            scn.check(msg.contains("unexpected"), format!("message {msg:?} lacks 'unexpected'"));
        }
        None => scn.check(false, "no result".to_string()),
    }
    let v = scn.eval_value("1");
    scn.expect_eq(v, Some("1".to_string()), "after error");
    scn.finish();
}

#[test]
fn e05_bare_end_syntax_error() {
    let mut scn = Scn::new("E05", "S4", "bare end is a syntax error", "SyntaxError, then session works");
    let ev = scn.eval_and_wait("end");
    let class = ev.as_ref().and_then(|e| field_str(e, "class"));
    scn.expect_eq(class, Some("SyntaxError".to_string()), "class");
    let v = scn.eval_value("2");
    scn.expect_eq(v, Some("2".to_string()), "after error");
    scn.finish();
}

#[test]
fn e06_runtime_errors() {
    let mut scn = Scn::new("E06", "S5", "exception class, message, backtrace", "NameError/ZeroDivisionError/RuntimeError/Exception");

    let ev = scn.eval_and_wait("foo_undefined").unwrap_or_default();
    scn.expect_eq(field_str(&ev, "class"), Some("NameError".to_string()), "NameError class");
    let msg = field_str(&ev, "message").unwrap_or_default();
    scn.check(
        msg.contains("undefined local variable or method"),
        format!("NameError message: {msg:?}"),
    );

    let ev = scn.eval_and_wait("1/0").unwrap_or_default();
    scn.expect_eq(field_str(&ev, "class"), Some("ZeroDivisionError".to_string()), "1/0 class");
    scn.expect_eq(field_str(&ev, "message"), Some("divided by 0".to_string()), "1/0 message");

    let ev = scn.eval_and_wait("raise \"boom\"").unwrap_or_default();
    scn.expect_eq(field_str(&ev, "class"), Some("RuntimeError".to_string()), "raise class");
    scn.expect_eq(field_str(&ev, "message"), Some("boom".to_string()), "raise message");

    let ev = scn.eval_and_wait("raise Exception, \"base\"").unwrap_or_default();
    scn.expect_eq(field_str(&ev, "class"), Some("Exception".to_string()), "Exception class");
    scn.expect_eq(field_str(&ev, "message"), Some("base".to_string()), "Exception message");

    let ev = scn.eval_and_wait("def f\n  raise 'x'\nend\nf\n").unwrap_or_default();
    let frames: Vec<String> = ev
        .get("backtrace")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|f| f.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    scn.check(!frames.is_empty(), "backtrace empty".to_string());
    scn.check(
        frames.iter().all(|f| f.starts_with("(rls):")),
        format!("frames not all (rls): {frames:?}"),
    );
    scn.check(
        frames.iter().any(|f| f.contains("(rls):2")),
        format!("no (rls):2 frame: {frames:?}"),
    );
    scn.check(
        !frames.iter().any(|f| f.contains("driver")),
        format!("driver frame present: {frames:?}"),
    );
    scn.finish();
}

#[test]
fn e07_stdout_stderr_ordering() {
    let mut scn = Scn::new("E07", "S6", "stdout and stderr precede the result", "a\\nc / b\\n, result 7");
    let id = scn.eval_id("puts \"a\"; $stderr.puts \"b\"; print \"c\"; 7");
    scn.drain(|ev| result_for(ev, id), RESULT_WAIT);
    let result_pos = scn
        .rig()
        .events
        .iter()
        .position(|(_, ev)| result_for(ev, id));
    scn.check(result_pos.is_some(), "no result".to_string());
    let output_after = result_pos.is_some_and(|pos| {
        scn.rig()
            .events
            .iter()
            .skip(pos + 1)
            .any(|(_, ev)| ev.get("type").and_then(|t| t.as_str()) == Some("output"))
    });
    scn.check(!output_after, "output after result".to_string());
    let stdout = scn.output_text("stdout");
    scn.expect_eq(stdout, "a\nc".to_string(), "stdout");
    let stderr = scn.output_text("stderr");
    scn.expect_eq(stderr, "b\n".to_string(), "stderr");
    let ev = scn.first_result(id).unwrap_or_default();
    scn.expect_eq(field_str(&ev, "value"), Some("7".to_string()), "value");

    let v = scn.eval_value("puts \"x\"");
    scn.expect_eq(v, Some("nil".to_string()), "puts value");
    let stdout2 = scn.output_text("stdout");
    scn.check(stdout2.ends_with("x\n"), format!("stdout2: {stdout2:?}"));
    scn.finish();
}

#[test]
fn e08_large_output() {
    let mut scn = Scn::new("E08", "S6", "200KB output fully captured", "200001 bytes before result");
    let id = scn.eval_id("puts \"y\" * 200_000; :done");
    scn.drain(|ev| result_for(ev, id), Duration::from_secs(30));
    let result_pos = scn
        .rig()
        .events
        .iter()
        .position(|(_, ev)| result_for(ev, id));
    let total: usize = scn
        .rig()
        .events
        .iter()
        .take(result_pos.unwrap_or(0))
        .filter(|(_, ev)| {
            ev.get("type").and_then(|t| t.as_str()) == Some("output")
                && ev.get("stream").and_then(|s| s.as_str()) == Some("stdout")
        })
        .map(|(_, ev)| ev.get("text").and_then(|t| t.as_str()).unwrap_or("").len())
        .sum();
    scn.expect_eq(total, 200_001usize, "stdout bytes before result");
    scn.finish();
}

#[test]
fn e09_stdin_gets() {
    let mut scn = Scn::new("E09", "S7", "user code can read stdin", "gets reads a line");
    let id = scn.eval_id("gets");
    std::thread::sleep(Duration::from_millis(200));
    scn.stdin("hello\n");
    scn.drain(|ev| result_for(ev, id), RESULT_WAIT);
    let ev = scn.first_result(id).unwrap_or_default();
    scn.expect_eq(field_str(&ev, "value"), Some("\"hello\\n\"".to_string()), "gets value");
    scn.finish();
}

#[test]
fn e10_interrupt_loop() {
    let mut scn = Scn::new("E10", "S8", "SIGINT interrupts a busy loop", "interrupted within 1000ms");
    let id = scn.eval_id("i = 0; loop { i += 1 }");
    std::thread::sleep(Duration::from_millis(300));
    let at = Instant::now();
    let action = scn.interrupt();
    scn.expect_eq(action, "interrupt", "interrupt()");
    scn.drain(|ev| result_for(ev, id), Duration::from_millis(1000));
    let latency = at.elapsed().as_millis() as u64;
    scn.metric("interrupt latency", latency, "ms", 1000);
    let status = scn.first_result(id).and_then(|e| status_of(&e));
    scn.expect_eq(status, Some("interrupted".to_string()), "status");
    let v = scn.eval_value("i > 0");
    scn.expect_eq(v, Some("true".to_string()), "i > 0");
    scn.finish();
}

#[test]
fn e11_interrupt_sleep() {
    let mut scn = Scn::new("E11", "S8", "SIGINT interrupts sleep", "interrupted within 1000ms");
    let id = scn.eval_id("sleep 100");
    std::thread::sleep(Duration::from_millis(300));
    let at = Instant::now();
    scn.interrupt();
    scn.drain(|ev| result_for(ev, id), Duration::from_millis(1000));
    let latency = at.elapsed().as_millis() as u64;
    scn.metric("interrupt latency", latency, "ms", 1000);
    let status = scn.first_result(id).and_then(|e| status_of(&e));
    scn.expect_eq(status, Some("interrupted".to_string()), "status");
    scn.finish();
}

#[test]
fn e12_interrupt_system() {
    let mut scn = Scn::new("E12", "S8", "SIGINT during system()", "a result within 1000ms");
    let id = scn.eval_id("system(\"sleep 100\")");
    std::thread::sleep(Duration::from_millis(300));
    let at = Instant::now();
    scn.interrupt();
    scn.drain(|ev| result_for(ev, id), Duration::from_millis(1000));
    let latency = at.elapsed().as_millis() as u64;
    scn.metric("interrupt latency", latency, "ms", 1000);
    let status = scn.first_result(id).and_then(|e| status_of(&e));
    scn.record("note", format!("status observed: {status:?}"));
    scn.check(status.is_some(), "no result within 1000ms".to_string());
    scn.finish();
}

#[test]
fn e13_interrupt_output_loop() {
    let mut scn = Scn::new("E13", "S8", "SIGINT interrupts an output loop", "interrupted within 2000ms");
    let id = scn.eval_id("loop { puts \"z\" * 100 }");
    std::thread::sleep(Duration::from_millis(300));
    let at = Instant::now();
    scn.interrupt();
    scn.drain(|ev| result_for(ev, id), Duration::from_millis(2000));
    let latency = at.elapsed().as_millis() as u64;
    scn.metric("interrupt latency", latency, "ms", 2000);
    let status = scn.first_result(id).and_then(|e| status_of(&e));
    scn.expect_eq(status, Some("interrupted".to_string()), "status");
    scn.finish();
}

#[test]
fn e14_kill_and_restart() {
    let mut scn = Scn::new("E14", "S9", "second Ctrl-C kills and restarts", "killed, restart, fresh state");
    let v = scn.eval_value("x = 41");
    scn.expect_eq(v, Some("41".to_string()), "x = 41");
    let id = scn.eval_id("trap(\"INT\") {}; loop {}");
    std::thread::sleep(Duration::from_millis(300));
    let action = scn.interrupt();
    scn.expect_eq(action, "interrupt", "first interrupt");
    let got_result = scn.drain(|ev| result_for(ev, id), Duration::from_millis(500));
    scn.check(!got_result, "unexpected result after trapped SIGINT".to_string());
    let at = Instant::now();
    let action = scn.interrupt();
    scn.expect_eq(action, "kill", "second interrupt");
    scn.drain(
        |ev| is_started(ev) && ev.get("generation").and_then(|v| v.as_u64()) == Some(2),
        Duration::from_millis(3000),
    );
    let latency = at.elapsed().as_millis() as u64;
    scn.metric("restart latency", latency, "ms", 3000);
    let killed = scn.events_where(|ev| {
        result_for(ev, id) && status_of(ev).as_deref() == Some("killed")
    });
    scn.check(!killed.is_empty(), "no killed result".to_string());
    let exited = scn.events_where(|ev| {
        ev.get("type").and_then(|t| t.as_str()) == Some("exited")
            && ev.get("reason").and_then(|v| v.as_str()) == Some("killed")
    });
    scn.check(!exited.is_empty(), "no exited/killed event".to_string());
    let started2 = scn.events_where(|ev| {
        is_started(ev) && ev.get("generation").and_then(|v| v.as_u64()) == Some(2)
    });
    scn.check(!started2.is_empty(), "no generation-2 started".to_string());
    let ev = scn.eval_and_wait("x").unwrap_or_default();
    scn.expect_eq(field_str(&ev, "class"), Some("NameError".to_string()), "x after restart");
    let v = scn.eval_value("1 + 1");
    scn.expect_eq(v, Some("2".to_string()), "1 + 1");
    scn.finish();
}

#[test]
fn e15_exit_restarts() {
    let mut scn = Scn::new("E15", "S10", "exit restarts ruby", "exited 0, restart, session works");
    let id = scn.eval_id("exit");
    scn.drain(
        |ev| is_started(ev) && ev.get("generation").and_then(|v| v.as_u64()) == Some(2),
        Duration::from_secs(10),
    );
    let res = scn.first_result(id).unwrap_or_default();
    scn.expect_eq(status_of(&res), Some("exited".to_string()), "exit status");
    scn.expect_eq(res.get("exitCode").and_then(|v| v.as_i64()), Some(0), "exit code");
    let exited = scn.events_where(|ev| {
        ev.get("type").and_then(|t| t.as_str()) == Some("exited")
            && ev.get("reason").and_then(|v| v.as_str()) == Some("exit")
    });
    scn.check(!exited.is_empty(), "no exited/exit event".to_string());
    let v = scn.eval_value("1");
    scn.expect_eq(v, Some("1".to_string()), "after restart");
    scn.finish();
}

#[test]
fn e16_exit_bang_restarts() {
    let mut scn = Scn::new("E16", "S10", "exit!(3) restarts ruby", "exited 3, restart, session works");
    let id = scn.eval_id("exit!(3)");
    scn.drain(
        |ev| is_started(ev) && ev.get("generation").and_then(|v| v.as_u64()) == Some(2),
        Duration::from_secs(10),
    );
    let res = scn.first_result(id).unwrap_or_default();
    scn.expect_eq(res.get("exitCode").and_then(|v| v.as_i64()), Some(3), "exit code");
    let v = scn.eval_value("1");
    scn.expect_eq(v, Some("1".to_string()), "after restart");
    scn.finish();
}

#[test]
fn e17_self_kill_restarts() {
    let mut scn = Scn::new("E17", "S10", "SIGKILL to self restarts ruby", "exited signal 9, crash, restart");
    let id = scn.eval_id("Process.kill(:KILL, $$)");
    scn.drain(
        |ev| is_started(ev) && ev.get("generation").and_then(|v| v.as_u64()) == Some(2),
        Duration::from_secs(10),
    );
    let res = scn.first_result(id).unwrap_or_default();
    scn.expect_eq(status_of(&res), Some("exited".to_string()), "status");
    scn.expect_eq(res.get("signal").and_then(|v| v.as_i64()), Some(9), "signal");
    let crash = scn.events_where(|ev| {
        ev.get("type").and_then(|t| t.as_str()) == Some("exited")
            && ev.get("reason").and_then(|v| v.as_str()) == Some("crash")
    });
    scn.check(!crash.is_empty(), "no exited/crash event".to_string());
    let v = scn.eval_value("1");
    scn.expect_eq(v, Some("1".to_string()), "after restart");
    scn.finish();
}

#[test]
fn e18_inspect_raises() {
    let mut scn = Scn::new("E18", "S5", "inspect failure is tolerated", "value mentions inspect raised");
    let v = scn.eval_value("o = Object.new; def o.inspect = raise(\"nope\"); o");
    match &v {
        Some(v) => {
            scn.check(v.starts_with("#<Object"), format!("value {v:?} lacks '#<Object'"));
            scn.check(v.contains("inspect raised"), format!("value {v:?} lacks 'inspect raised'"));
        }
        None => scn.check(false, "no result".to_string()),
    }
    scn.finish();
}

#[test]
fn e19_idle_interrupt() {
    let mut scn = Scn::new("E19", "S8", "Ctrl-C while idle is a no-op", "\"idle\", session unaffected");
    let action = scn.interrupt();
    scn.expect_eq(action, "idle", "interrupt()");
    let v = scn.eval_value("3");
    scn.expect_eq(v, Some("3".to_string()), "3");
    scn.finish();
}

#[test]
fn e20_no_driver_locals() {
    let mut scn = Scn::new("E20", "S2", "driver leaves no locals behind", "local_variables == []");
    let v = scn.eval_value("local_variables");
    scn.expect_eq(v, Some("[]".to_string()), "local_variables");
    scn.finish();
}

#[test]
fn e21_utf8_output() {
    let mut scn = Scn::new("E21", "S6", "UTF-8 round-trips", "héllo ✓");
    let id = scn.eval_id("puts \"héllo ✓\"; \"✓\"");
    scn.drain(|ev| result_for(ev, id), RESULT_WAIT);
    let stdout = scn.output_text("stdout");
    scn.expect_eq(stdout, "héllo ✓\n".to_string(), "stdout");
    let ev = scn.first_result(id).unwrap_or_default();
    scn.expect_eq(field_str(&ev, "value"), Some("\"✓\"".to_string()), "value");
    scn.finish();
}

#[test]
fn e22_busy_eval_rejected() {
    let mut scn = Scn::new("E22", "S1", "one eval at a time", "second eval returns Err");
    let id = scn.eval_id("sleep 1");
    let second = scn.try_eval("2");
    scn.check(second.is_err(), format!("second eval: {second:?}"));
    scn.drain(|ev| result_for(ev, id), RESULT_WAIT);
    let status = scn.first_result(id).and_then(|e| status_of(&e));
    scn.expect_eq(status, Some("ok".to_string()), "first eval status");
    scn.finish();
}

#[test]
fn e23_bad_ruby_path() {
    let mut scn = Scn::new("E23", "S10", "bad ruby path is a clean error", "spawn Err mentions the path");
    let cfg = SessionConfig { ruby: "/nonexistent/ruby".to_string() };
    scn.record("spawn", format!("{:?}", cfg.ruby));
    match Session::spawn(cfg, Arc::new(|_: RubyEvent| {})) {
        Ok(_) => scn.check(false, "spawn succeeded unexpectedly".to_string()),
        Err(e) => scn.check(e.contains("/nonexistent/ruby"), format!("error {e:?} lacks path")),
    }
    scn.finish();
}

#[test]
fn e24_underscore_last_value() {
    let mut scn = Scn::new("E24", "S14", "_ holds the most recent value", "a = _ after 234 ** 2 gives 54756; errors leave _ alone");
    let v = scn.eval_value("234 ** 2");
    scn.expect_eq(v, Some("54756".to_string()), "234 ** 2");
    let v = scn.eval_value("a = _");
    scn.expect_eq(v, Some("54756".to_string()), "a = _");
    let v = scn.eval_value("a");
    scn.expect_eq(v, Some("54756".to_string()), "a");
    let v = scn.eval_value("\"x\"");
    scn.expect_eq(v, Some("\"x\"".to_string()), "\"x\"");
    let id = scn.eval_id("nil.foo");
    scn.drain(|ev| result_for(ev, id), Duration::from_millis(2000));
    let status = scn.first_result(id).and_then(|e| status_of(&e));
    scn.expect_eq(status, Some("error".to_string()), "nil.foo is an error");
    let v = scn.eval_value("_");
    scn.expect_eq(v, Some("\"x\"".to_string()), "_ unchanged by the error");
    scn.finish();
}

// ---------- Snapshot scenarios ----------

#[test]
fn v01_locals_snapshot() {
    let mut scn = Scn::new("V01", "S15", "locals appear and update", "x = 14 then x = [1, 2]");
    let ev = scn.eval_and_wait("x = 14").unwrap_or_default();
    scn.expect_eq(
        snap_entries(&ev, "locals"),
        vec![("x".to_string(), "14".to_string())],
        "locals after x = 14",
    );
    let ev = scn.eval_and_wait("x = [1, 2]").unwrap_or_default();
    scn.expect_eq(
        snap_entries(&ev, "locals"),
        vec![("x".to_string(), "[1, 2]".to_string())],
        "locals after reassign",
    );
    scn.check(
        !snap_entries(&ev, "locals").iter().any(|(n, _)| n == "_"),
        "_ appears in locals".to_string(),
    );
    scn.finish();
}

#[test]
fn v02_ivars_snapshot() {
    let mut scn = Scn::new("V02", "S15", "main ivars appear", "@shoe_size = 10");
    let ev = scn.eval_and_wait("@shoe_size = 10").unwrap_or_default();
    scn.expect_eq(
        snap_entries(&ev, "ivars"),
        vec![("@shoe_size".to_string(), "10".to_string())],
        "ivars",
    );
    scn.finish();
}

#[test]
fn v03_class_snapshot() {
    let mut scn = Scn::new("V03", "S15", "class definitions appear with source", "Foo source");
    let src = "class Foo\n  def a\n  end\n  def b\n  end\nend";
    let ev = scn.eval_and_wait(src).unwrap_or_default();
    scn.expect_eq(
        snap_entries(&ev, "classes"),
        vec![("Foo".to_string(), src.to_string())],
        "classes",
    );
    scn.finish();
}

#[test]
fn v04_method_snapshot() {
    let mut scn = Scn::new("V04", "S15", "method defs appear and update", "sq source");
    let ev = scn.eval_and_wait("def sq(n) = n * n").unwrap_or_default();
    scn.check(
        snap_entries(&ev, "methods")
            .contains(&("sq".to_string(), "def sq(n) = n * n".to_string())),
        format!("methods: {:?}", snap_entries(&ev, "methods")),
    );
    let ev = scn.eval_and_wait("def sq(n) = n + n").unwrap_or_default();
    scn.check(
        snap_entries(&ev, "methods")
            .contains(&("sq".to_string(), "def sq(n) = n + n".to_string())),
        format!("methods after redef: {:?}", snap_entries(&ev, "methods")),
    );
    scn.finish();
}

#[test]
fn v05_error_keeps_old_method_source() {
    let mut scn = Scn::new(
        "V05",
        "S15",
        "erroring def does not overwrite recorded source",
        "g keeps first source",
    );
    let ev = scn.eval_and_wait("def g\n  1\nend").unwrap_or_default();
    scn.check(
        snap_entries(&ev, "methods")
            .contains(&("g".to_string(), "def g\n  1\nend".to_string())),
        format!("methods: {:?}", snap_entries(&ev, "methods")),
    );
    let ev = scn
        .eval_and_wait("raise \"boom\"; def g\n  2\nend")
        .unwrap_or_default();
    scn.expect_eq(status_of(&ev), Some("error".to_string()), "status");
    scn.check(ev.get("snapshot").is_some(), "no snapshot".to_string());
    scn.check(
        snap_entries(&ev, "methods")
            .contains(&("g".to_string(), "def g\n  1\nend".to_string())),
        format!("methods after error: {:?}", snap_entries(&ev, "methods")),
    );
    scn.finish();
}

#[test]
fn v06_method_defined_before_raise() {
    let mut scn = Scn::new("V06", "S15", "def before a raise is captured", "h present after error");
    let ev = scn.eval_and_wait("def h = 1; raise \"boom\"").unwrap_or_default();
    scn.expect_eq(status_of(&ev), Some("error".to_string()), "status");
    scn.check(
        snap_entries(&ev, "methods")
            .contains(&("h".to_string(), "def h = 1".to_string())),
        format!("methods: {:?}", snap_entries(&ev, "methods")),
    );
    scn.finish();
}

#[test]
fn v07_inspect_raises_still_snapshots() {
    let mut scn = Scn::new("V07", "S15", "bad inspect tolerated in snapshot", "o has fallback text");
    let ev = scn
        .eval_and_wait("o = Object.new; def o.inspect = raise(\"no\"); o")
        .unwrap_or_default();
    let locals = snap_entries(&ev, "locals");
    let o = locals.iter().find(|(n, _)| n == "o").map(|(_, t)| t.clone());
    match o {
        Some(t) => {
            scn.check(t.starts_with("#<Object"), format!("o text {t:?}"));
            scn.check(t.contains("inspect raised"), format!("o text {t:?}"));
        }
        None => scn.check(false, format!("no o in locals: {locals:?}")),
    }
    scn.finish();
}

#[test]
fn v08_long_value_truncated() {
    let mut scn = Scn::new("V08", "S15", "long values truncated", "big <= 4001 chars + ellipsis");
    let ev = scn.eval_and_wait("big = (1..5000).to_a").unwrap_or_default();
    let locals = snap_entries(&ev, "locals");
    let t = locals
        .iter()
        .find(|(n, _)| n == "big")
        .map(|(_, t)| t.clone())
        .unwrap_or_default();
    scn.check(t.chars().count() <= 4001, format!("len {}", t.chars().count()));
    scn.check(t.ends_with('…'), format!("no ellipsis: ...{:?}", &t[t.len().saturating_sub(20)..]));
    scn.finish();
}
