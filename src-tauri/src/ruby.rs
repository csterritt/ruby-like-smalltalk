use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DRIVER_SRC: &str = include_str!("../ruby/driver.rb");
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub ruby: String,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            ruby: std::env::var("RLS_RUBY").unwrap_or_else(|_| "ruby".to_string()),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RubyEvent {
    Started {
        generation: u64,
        version: String,
    },
    Output {
        stream: Stream,
        text: String,
    },
    Result {
        id: u64,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        class: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        backtrace: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        syntax: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
    },
    Exited {
        generation: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
        reason: String,
    },
    Unavailable {
        message: String,
    },
}

type Sink = Arc<dyn Fn(RubyEvent) + Send + Sync>;

struct HeldResult {
    id: u64,
    reply: serde_json::Value,
    need: Vec<Stream>,
}

#[derive(Default)]
struct State {
    generation: u64,
    pid: Option<u32>,
    stdin: Option<std::process::ChildStdin>,
    ctrl: Option<UnixStream>,
    next_id: u64,
    pending_eval: Option<u64>,
    interrupted: bool,
    held: Option<HeldResult>,
    markers: HashSet<(u64, Stream)>,
    exit_reported: bool,
    reply_waiters: Vec<(u64, mpsc::Sender<serde_json::Value>)>,
    handles: Vec<JoinHandle<()>>,
    dead: bool,
}

struct Inner {
    cfg: SessionConfig,
    sink: Sink,
    driver_path: PathBuf,
    nonce: String,
    state: Mutex<State>,
}

pub struct Session {
    inner: Arc<Inner>,
}

fn emit(inner: &Inner, ev: RubyEvent) {
    (inner.sink)(ev);
}

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn driver_path() -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("rls-driver-{:016x}.rb", hash_str(DRIVER_SRC)));
    let same = std::fs::read(&path)
        .map(|existing| existing == DRIVER_SRC.as_bytes())
        .unwrap_or(false);
    if !same {
        std::fs::write(&path, DRIVER_SRC)
            .map_err(|e| format!("write driver {}: {e}", path.display()))?;
    }
    Ok(path)
}

fn make_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = DefaultHasher::new();
    nanos.hash(&mut h);
    std::process::id().hash(&mut h);
    format!("{:016x}", h.finish())
}

// Split buf into emitted text bytes, completed marker ids, and a held
// tail that may be the start of a marker.
fn extract_markers(
    buf: &[u8],
    prefix: &[u8],
    out: &mut Vec<u8>,
    ids: &mut Vec<u64>,
) -> usize {
    let mut i = 0;
    let mut seg = 0;
    while i < buf.len() {
        if buf[i] == 0 {
            let rem = &buf[i..];
            if rem.len() < prefix.len() {
                if prefix.starts_with(rem) {
                    break;
                }
            } else if rem.starts_with(prefix) {
                let mut j = prefix.len();
                let digits = j;
                while j < rem.len() && rem[j].is_ascii_digit() {
                    j += 1;
                }
                if j == rem.len() {
                    break;
                }
                if rem[j] == b'\n' && j > digits {
                    out.extend_from_slice(&buf[seg..i]);
                    if let Ok(id) = std::str::from_utf8(&rem[digits..j])
                        .unwrap_or("0")
                        .parse::<u64>()
                    {
                        ids.push(id);
                    }
                    i += j + 1;
                    seg = i;
                    continue;
                }
            }
        }
        i += 1;
    }
    out.extend_from_slice(&buf[seg..i]);
    i
}

// Append bytes to `tail`, decoding as much valid UTF-8 as possible and
// holding any incomplete trailing sequence.
fn decode_push(tail: &mut Vec<u8>, bytes: &[u8], out: &mut String) {
    let mut buf = std::mem::take(tail);
    buf.extend_from_slice(bytes);
    loop {
        match std::str::from_utf8(&buf) {
            Ok(s) => {
                out.push_str(s);
                return;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // The prefix is valid UTF-8 by definition of valid_up_to.
                out.push_str(std::str::from_utf8(&buf[..valid]).unwrap_or(""));
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        buf = buf[valid + bad..].to_vec();
                    }
                    None => {
                        *tail = buf[valid..].to_vec();
                        return;
                    }
                }
            }
        }
    }
}

fn result_event_from_reply(id: u64, reply: &serde_json::Value) -> RubyEvent {
    let get = |k: &str| reply.get(k).cloned();
    RubyEvent::Result {
        id,
        status: get("status")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "error".to_string()),
        value: get("value").and_then(|v| v.as_str().map(str::to_owned)),
        class: get("class").and_then(|v| v.as_str().map(str::to_owned)),
        message: get("message").and_then(|v| v.as_str().map(str::to_owned)),
        backtrace: get("backtrace").and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|f| f.as_str().map(str::to_owned))
                    .collect()
            })
        }),
        syntax: get("syntax").and_then(|v| v.as_bool()),
        exit_code: None,
        signal: None,
    }
}

// Emit a held eval Result once a marker for its id has been seen on
// every stream the driver listed.
fn maybe_emit_result(inner: &Inner, st: &mut State) {
    let Some(held) = &st.held else { return };
    if !held
        .need
        .iter()
        .all(|s| st.markers.contains(&(held.id, *s)))
    {
        return;
    }
    let held = st.held.take().unwrap();
    if st.pending_eval == Some(held.id) {
        st.pending_eval = None;
    }
    st.interrupted = false;
    emit(inner, result_event_from_reply(held.id, &held.reply));
}

fn pipe_reader(inner: Arc<Inner>, generation: u64, stream: Stream, mut rd: impl Read + Send + 'static) {
    let prefix = format!("\x00RLS:{}:", inner.nonce).into_bytes();
    let mut pending: Vec<u8> = Vec::new();
    let mut tail: Vec<u8> = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = match rd.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => {
                break;
            }
        };
        
        let mut raw = std::mem::take(&mut pending);
        raw.extend_from_slice(&buf[..n]);
        let mut text_bytes = Vec::new();
        let mut ids = Vec::new();
        let hold = extract_markers(&raw, &prefix, &mut text_bytes, &mut ids);
        pending = raw[hold..].to_vec();
        let mut text = String::new();
        decode_push(&mut tail, &text_bytes, &mut text);
        let mut st = inner.state.lock().unwrap();
        if st.generation == generation && !st.dead {
            if !text.is_empty() {
                emit(&inner, RubyEvent::Output { stream, text });
            }
            for id in ids {
                st.markers.insert((id, stream));
            }
            maybe_emit_result(&inner, &mut st);
        }
    }
    // EOF: flush whatever is left as output.
    let mut text = String::new();
    decode_push(&mut tail, &pending, &mut text);
    if !tail.is_empty() {
        text.push('\u{FFFD}');
    }
    if !text.is_empty() {
        let st = inner.state.lock().unwrap();
        if st.generation == generation && !st.dead {
            emit(&inner, RubyEvent::Output { stream, text });
        }
    }
}

fn ctrl_reader(inner: Arc<Inner>, generation: u64, rd: UnixStream) {
    let mut reader = BufReader::new(rd);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line.trim_end()) else {
            continue;
        };
        let mut st = inner.state.lock().unwrap();
        if st.generation != generation || st.dead {
            continue;
        }
        match msg.get("op").and_then(|v| v.as_str()) {
            Some("hello") => {
                let version = msg
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                emit(&inner, RubyEvent::Started { generation, version });
            }
            _ => {
                let id = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                if msg.get("status").is_some() {
                    // eval reply: hold until markers arrive
                    let need = msg
                        .get("markers")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|s| match s.as_str() {
                                    Some("stdout") => Some(Stream::Stdout),
                                    Some("stderr") => Some(Stream::Stderr),
                                    _ => None,
                                })
                                .collect::<Vec<Stream>>()
                        })
                        .unwrap_or_default();
                    st.held = Some(HeldResult { id, reply: msg, need });
                    maybe_emit_result(&inner, &mut st);
                } else {
                    // check reply (or error): route to a waiting caller
                    if let Some(pos) = st.reply_waiters.iter().position(|(wid, _)| *wid == id) {
                        let (_, tx) = st.reply_waiters.remove(pos);
                        let _ = tx.send(msg);
                    }
                }
            }
        }
    }
}

fn reaper(
    inner: Arc<Inner>,
    generation: u64,
    mut child: Child,
    reader_handles: Vec<JoinHandle<()>>,
) {
    let status = child.wait();
    for h in reader_handles {
        let _ = h.join();
    }
    let (code, sig) = match &status {
        Ok(s) => (s.code(), s.signal()),
        Err(_) => (None, None),
    };
    let mut restart = false;
    {
        let mut st = inner.state.lock().unwrap();
        if st.generation == generation && !st.exit_reported {
            st.exit_reported = true;
            if let Some(id) = st.pending_eval.take() {
                emit(
                    &inner,
                    RubyEvent::Result {
                        id,
                        status: "exited".to_string(),
                        value: None,
                        class: None,
                        message: None,
                        backtrace: None,
                        syntax: None,
                        exit_code: code,
                        signal: sig,
                    },
                );
            }
            emit(
                &inner,
                RubyEvent::Exited {
                    generation,
                    exit_code: code,
                    signal: sig,
                    reason: if code.is_some() { "exit" } else { "crash" }.to_string(),
                },
            );
            restart = !st.dead;
        }
    }
    if restart {
        restart_ruby(&inner);
    }
}

static SOCK_COUNTER: AtomicU64 = AtomicU64::new(0);

fn spawn_child(inner: &Arc<Inner>, generation: u64) -> Result<(), String> {
    let sock_path = std::env::temp_dir().join(format!(
        "rls-{}-{}.sock",
        std::process::id(),
        SOCK_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let listener = UnixListener::bind(&sock_path)
        .map_err(|e| format!("bind {}: {e}", sock_path.display()))?;
    let mut child = Command::new(&inner.cfg.ruby)
        .arg(&inner.driver_path)
        .env("RLS_CONTROL", &sock_path)
        .env("RLS_NONCE", &inner.nonce)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("spawn {} failed: {e}", inner.cfg.ruby))?;

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("listener nonblocking: {e}"))?;
    let deadline = Instant::now() + ACCEPT_TIMEOUT;
    let ctrl = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = std::fs::remove_file(&sock_path);
                    return Err("ruby did not connect to the control socket".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = std::fs::remove_file(&sock_path);
                return Err(format!("accept: {e}"));
            }
        }
    };
    let _ = std::fs::remove_file(&sock_path);
    ctrl.set_nonblocking(false)
        .map_err(|e| format!("control stream blocking: {e}"))?;

    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let ctrl_w = match ctrl.try_clone() {
        Ok(s) => s,
        Err(e) => {
            let _ = child.kill();
            return Err(format!("clone control stream: {e}"));
        }
    };

    let mut readers = Vec::new();
    if let Some(out) = stdout {
        readers.push(std::thread::spawn({
            let inner = share(inner);
            move || pipe_reader(inner, generation, Stream::Stdout, out)
        }));
    }
    if let Some(err) = stderr {
        readers.push(std::thread::spawn({
            let inner = share(inner);
            move || pipe_reader(inner, generation, Stream::Stderr, err)
        }));
    }
    readers.push(std::thread::spawn({
        let inner = share(inner);
        move || ctrl_reader(inner, generation, ctrl)
    }));
    let reaper_handle = std::thread::spawn({
        let inner = share(inner);
        move || reaper(inner, generation, child, readers)
    });

    let mut st = inner.state.lock().unwrap();
    st.pid = Some(pid);
    st.stdin = stdin;
    st.ctrl = Some(ctrl_w);
    st.handles.push(reaper_handle);
    Ok(())
}

fn share(inner: &Arc<Inner>) -> Arc<Inner> {
    Arc::clone(inner)
}

fn restart_ruby(inner: &Arc<Inner>) {
    let generation = {
        let mut st = inner.state.lock().unwrap();
        st.generation += 1;
        st.markers.clear();
        st.held = None;
        st.pending_eval = None;
        st.interrupted = false;
        st.exit_reported = false;
        st.stdin = None;
        st.ctrl = None;
        st.pid = None;
        st.generation
    };
    if let Err(e) = spawn_child(inner, generation) {
        let mut st = inner.state.lock().unwrap();
        st.dead = true;
        emit(
            inner,
            RubyEvent::Output {
                stream: Stream::Stderr,
                text: format!("rls: restart failed: {e}\n"),
            },
        );
    }
}

fn send_ctrl(st: &mut State, msg: &serde_json::Value) -> Result<(), String> {
    let ctrl = st.ctrl.as_mut().ok_or("ruby is not running")?;
    let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    line.push('\n');
    ctrl.write_all(line.as_bytes())
        .and_then(|_| ctrl.flush())
        .map_err(|e| format!("control write: {e}"))
}

impl Session {
    pub fn spawn(
        cfg: SessionConfig,
        sink: Arc<dyn Fn(RubyEvent) + Send + Sync>,
    ) -> Result<Session, String> {
        let path = driver_path()?;
        let inner = Arc::new(Inner {
            cfg,
            sink,
            driver_path: path,
            nonce: make_nonce(),
            state: Mutex::new(State {
                generation: 1,
                next_id: 1,
                ..State::default()
            }),
        });
        spawn_child(&inner, 1)?;
        Ok(Session { inner })
    }

    pub fn check(&self, code: &str) -> Result<bool, String> {
        let code = ensure_trailing_newline(code);
        let (tx, rx) = mpsc::channel();
        let id = {
            let mut st = self.inner.state.lock().unwrap();
            if st.dead {
                return Err("ruby is not running".to_string());
            }
            if st.pending_eval.is_some() {
                return Err("ruby is busy".to_string());
            }
            let id = st.next_id;
            st.next_id += 1;
            st.reply_waiters.push((id, tx));
            if let Err(e) =
                send_ctrl(&mut st, &serde_json::json!({"id": id, "op": "check", "code": code}))
            {
                st.reply_waiters.retain(|(wid, _)| *wid != id);
                return Err(e);
            }
            id
        };
        let reply = rx
            .recv_timeout(CHECK_TIMEOUT)
            .map_err(|_| "check timed out".to_string());
        {
            let mut st = self.inner.state.lock().unwrap();
            st.reply_waiters.retain(|(wid, _)| *wid != id);
        }
        let reply = reply?;
        if let Some(err) = reply.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }
        reply
            .get("complete")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| "bad check reply".to_string())
    }

    pub fn eval(&self, code: &str) -> Result<u64, String> {
        let code = ensure_trailing_newline(code);
        let mut st = self.inner.state.lock().unwrap();
        if st.dead {
            return Err("ruby is not running".to_string());
        }
        if st.pending_eval.is_some() {
            return Err("an eval is already pending".to_string());
        }
        let id = st.next_id;
        st.next_id += 1;
        send_ctrl(&mut st, &serde_json::json!({"id": id, "op": "eval", "code": code}))?;
        st.pending_eval = Some(id);
        st.interrupted = false;
        Ok(id)
    }

    pub fn stdin(&self, text: &str) -> Result<(), String> {
        let mut st = self.inner.state.lock().unwrap();
        let stdin = st.stdin.as_mut().ok_or("ruby is not running")?;
        stdin
            .write_all(text.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("stdin write: {e}"))
    }

    pub fn interrupt(&self) -> &'static str {
        let mut st = self.inner.state.lock().unwrap();
        let Some(id) = st.pending_eval else {
            return "idle";
        };
        let Some(pid) = st.pid.filter(|p| *p > 0 && *p <= i32::MAX as u32) else {
            return "idle";
        };
        let pid = pid as i32;
        if !st.interrupted {
            st.interrupted = true;
            drop(st);
            unsafe {
                libc::kill(-pid, libc::SIGINT);
            }
            return "interrupt";
        }
        // Second interrupt: kill and restart.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        st.pending_eval = None;
        st.interrupted = false;
        st.held = None;
        st.exit_reported = true;
        let generation = st.generation;
        emit(
            &self.inner,
            RubyEvent::Result {
                id,
                status: "killed".to_string(),
                value: None,
                class: None,
                message: None,
                backtrace: None,
                syntax: None,
                exit_code: None,
                signal: Some(libc::SIGKILL),
            },
        );
        emit(
            &self.inner,
            RubyEvent::Exited {
                generation,
                exit_code: None,
                signal: Some(libc::SIGKILL),
                reason: "killed".to_string(),
            },
        );
        drop(st);
        restart_ruby(&self.inner);
        "kill"
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let handles = {
            let mut st = self.inner.state.lock().unwrap();
            st.dead = true;
            if let Some(pid) = st.pid.take().filter(|p| *p > 0 && *p <= i32::MAX as u32) {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            st.ctrl = None; // closing the control socket makes the driver exit
            std::mem::take(&mut st.handles)
        };
        for h in handles {
            let _ = h.join();
        }
    }
}

fn ensure_trailing_newline(code: &str) -> String {
    if code.ends_with('\n') {
        code.to_string()
    } else {
        format!("{code}\n")
    }
}
