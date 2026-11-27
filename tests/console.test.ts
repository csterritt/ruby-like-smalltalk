import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  ConsoleModel,
  initialState,
  type Backend,
  type Item,
  type RubyEvent,
  type Timers,
} from "../src/console";

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const p = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { p, resolve, reject };
}

class FakeTimers implements Timers {
  now = 0;
  private timers = new Map<unknown, { fn: () => void; at: number }>();
  private nextId = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h);
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let best: { id: unknown; at: number } | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= end && (best === null || t.at < best.at)) best = { id, at: t.at };
      }
      if (!best) break;
      const t = this.timers.get(best.id)!;
      this.timers.delete(best.id);
      this.now = t.at;
      t.fn();
    }
    this.now = end;
  }
}

type Call = { op: string; arg: string };

class Scn {
  transcript: object[] = [];
  failures: string[] = [];
  t0 = Date.now();
  timers = new FakeTimers();
  calls: Call[] = [];
  checkImpl: (code: string) => Promise<boolean> = async () => true;
  evalImpl: (code: string) => Promise<number> = async () => 1;
  stdinImpl: (text: string) => Promise<void> = async () => {};
  interruptImpl: () => Promise<"idle" | "interrupt" | "kill"> = async () => "idle";
  backend: Backend;
  model: ConsoleModel;

  constructor(
    public id: string,
    public title: string,
    public expect: string,
  ) {
    this.backend = {
      check: (code) => {
        this.calls.push({ op: "check", arg: code });
        return this.checkImpl(code);
      },
      eval: (code) => {
        this.calls.push({ op: "eval", arg: code });
        return this.evalImpl(code);
      },
      stdin: (text) => {
        this.calls.push({ op: "stdin", arg: text });
        return this.stdinImpl(text);
      },
      interrupt: () => {
        this.calls.push({ op: "interrupt", arg: "" });
        return this.interruptImpl();
      },
    };
    this.model = new ConsoleModel(this.backend, initialState(), this.timers);
    this.started();
  }

  get state() {
    return this.model.state;
  }

  rec(dir: "in" | "out", kind: string, detail: string) {
    this.transcript.push({ tMs: Date.now() - this.t0, dir, kind, detail });
  }

  snap(label: string) {
    this.rec(
      "out",
      "state",
      `${label}: mode=${this.state.mode} pending=${JSON.stringify(this.state.pending)} line=${JSON.stringify(this.state.line)} items=${JSON.stringify(this.state.items)}`,
    );
  }

  started(generation = 1, version = "ruby 3.4.13 fake") {
    this.model.onEvent({ type: "started", generation, version });
  }

  result(ev: Partial<Extract<RubyEvent, { type: "result" }>> & { id?: number }) {
    this.model.onEvent({ type: "result", id: 1, status: "ok", ...ev } as RubyEvent);
    this.snap("result");
  }

  expectEq<T>(got: T, want: T, label: string) {
    this.rec("out", "assert", `${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      this.failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  expectTrue(cond: boolean, label: string) {
    this.rec("out", "assert", `${label}: ${cond}`);
    if (!cond) this.failures.push(label);
  }

  finish() {
    const dir = process.env.RLS_REPORT_DIR;
    if (dir) {
      const sd = join(dir, "scenarios");
      if (!existsSync(sd)) mkdirSync(sd, { recursive: true });
      writeFileSync(
        join(sd, `${this.id}.json`),
        JSON.stringify({
          id: this.id,
          criterion: "S11",
          title: this.title,
          expect: this.expect,
          pass: this.failures.length === 0,
          durationMs: Date.now() - this.t0,
          metric: null,
          transcript: this.transcript,
          failure: this.failures.length ? this.failures.join("; ") : null,
        }),
      );
    }
    expect(this.failures).toEqual([]);
  }
}

function itemsOf(scn: Scn, kind: Item["kind"]): Item[] {
  return scn.state.items.filter((i) => i.kind === kind);
}

function notices(scn: Scn): string[] {
  return itemsOf(scn, "notice").map((i) => (i as { text: string }).text);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("C01 complete one-liner", async () => {
  const s = new Scn("C01", "complete one-liner", "check+eval, value shown");
  s.model.setLine("1 + 2");
  await s.model.enter();
  s.snap("after enter");
  s.expectEq(s.calls, [
    { op: "check", arg: "1 + 2\n" },
    { op: "eval", arg: "1 + 2\n" },
  ], "calls");
  s.expectEq(itemsOf(s, "input"), [{ kind: "input", prompt: "rb> ", text: "1 + 2" }], "items");
  s.expectEq(s.state.mode, "busy", "mode");
  s.result({ status: "ok", value: "3" });
  s.expectEq(itemsOf(s, "value"), [{ kind: "value", text: "3" }], "value item");
  s.expectEq(s.state.mode, "idle", "mode idle");
  s.finish();
});

test("C02 multi-line entry", async () => {
  const s = new Scn("C02", "multi-line entry", "pending not echoed, joined check");
  let n = 0;
  s.checkImpl = async () => ++n < 3 ? false : true;
  s.model.setLine("def f");
  await s.model.enter();
  s.expectEq(s.state.pending, ["def f"], "pending");
  s.expectEq(s.model.prompt, "..> ", "prompt");
  s.expectEq(s.state.items.length, 1, "no echo while pending"); // started notice only
  s.model.setLine("  1");
  await s.model.enter();
  s.model.setLine("end");
  await s.model.enter();
  s.snap("after end");
  s.expectEq(s.calls[s.calls.length - 2], { op: "check", arg: "def f\n  1\nend\n" }, "joined check");
  s.expectEq(s.calls[s.calls.length - 1], { op: "eval", arg: "def f\n  1\nend\n" }, "one eval");
  s.expectEq(
    s.state.items.slice(-3),
    [
      { kind: "input", prompt: "rb> ", text: "def f" },
      { kind: "input", prompt: "..> ", text: "  1" },
      { kind: "input", prompt: "..> ", text: "end" },
    ],
    "flushed inputs",
  );
  s.finish();
});

test("C03 ctrl-C cancels entry", async () => {
  const s = new Scn("C03", "ctrl-C cancels entry", "lines flushed cancelled, no interrupt");
  s.checkImpl = async () => false;
  s.model.setLine("def f");
  await s.model.enter();
  s.model.setLine("  1");
  await s.model.ctrlC();
  s.snap("after ctrlC");
  s.expectEq(
    s.state.items.slice(-2),
    [
      { kind: "input", prompt: "rb> ", text: "def f" },
      { kind: "input", prompt: "..> ", text: "  1", cancelled: true },
    ],
    "cancelled flush",
  );
  s.expectEq(s.state.pending, [], "pending cleared");
  s.expectTrue(!s.calls.some((c) => c.op === "interrupt"), "interrupt not called");
  const before = s.state.items.length;
  await s.model.ctrlC();
  s.expectEq(s.state.items[before], { kind: "input", prompt: "rb> ", text: "", cancelled: true }, "empty cancel");
  s.finish();
});

test("C04 busy ctrl-C interrupt then kill", async () => {
  const s = new Scn("C04", "busy ctrl-C", "warn after 1000ms, kill restarts");
  s.interruptImpl = async () => (s.calls.filter((c) => c.op === "interrupt").length > 1 ? "kill" : "interrupt");
  s.model.setLine("loop {}");
  await s.model.enter();
  await s.model.ctrlC();
  s.snap("after first ctrlC");
  s.expectTrue(notices(s).includes("^C"), "^C notice");
  s.timers.advance(1000);
  s.expectTrue(notices(s).some((t) => t.includes("Ctrl-C again")), "still running warn");
  await s.model.ctrlC();
  s.result({ status: "killed" });
  s.expectTrue(notices(s).some((t) => t.includes("definitions are gone")), "killed notice");
  s.expectEq(s.state.mode, "starting", "mode starting");
  s.started(2);
  s.expectTrue(notices(s).some((t) => t.includes("New Ruby session")), "restart notice");
  s.expectEq(s.state.mode, "idle", "mode idle");
  s.finish();
});

test("C04b interrupted before warn", async () => {
  const s = new Scn("C04", "busy ctrl-C", "interrupted before 1000ms shows no again-notice");
  s.interruptImpl = async () => "interrupt";
  s.model.setLine("loop {}");
  await s.model.enter();
  await s.model.ctrlC();
  s.result({ status: "interrupted", backtrace: ["(rls):1:in 'loop'"] });
  s.timers.advance(2000);
  s.expectTrue(notices(s).some((t) => t === "Interrupted at (rls):1:in 'loop'"), "interrupted notice");
  s.expectTrue(!notices(s).some((t) => t.includes("Ctrl-C again")), "no again notice");
  s.finish();
});

test("C05 busy Enter sends stdin", async () => {
  const s = new Scn("C05", "busy Enter", "stdin call, stdin item, no check");
  s.model.setLine("gets");
  await s.model.enter();
  const checksBefore = s.calls.filter((c) => c.op === "check").length;
  s.model.setLine("abc");
  await s.model.enter();
  s.snap("after stdin enter");
  s.expectEq(s.calls[s.calls.length - 1], { op: "stdin", arg: "abc\n" }, "stdin call");
  s.expectEq(s.state.items[s.state.items.length - 1], { kind: "stdin", text: "abc" }, "stdin item");
  s.expectEq(s.calls.filter((c) => c.op === "check").length, checksBefore, "no extra check");
  s.finish();
});

test("C06 history", async () => {
  const s = new Scn("C06", "history", "recall, draft, dup collapse, pending guard");
  async function evalLine(code: string) {
    s.model.setLine(code);
    await s.model.enter();
    s.result({ status: "ok", value: "1" });
  }
  await evalLine("a = 1");
  await evalLine("b = 2");
  await evalLine("b = 2"); // consecutive duplicate stored once
  s.model.setLine("my draft");
  s.model.historyPrev();
  s.expectEq(s.state.line, "b = 2", "prev newest");
  s.model.historyPrev();
  s.expectEq(s.state.line, "a = 1", "prev older");
  s.model.historyPrev();
  s.expectEq(s.state.line, "a = 1", "prev at oldest stays");
  s.model.historyNext();
  s.expectEq(s.state.line, "b = 2", "next");
  s.model.historyNext();
  s.expectEq(s.state.line, "my draft", "draft restored");
  // multi-line recall
  s.checkImpl = async (c) => c === "def g\n2\nend\n";
  s.model.setLine("def g");
  await s.model.enter();
  s.model.setLine("2");
  await s.model.enter();
  s.model.setLine("end");
  await s.model.enter();
  s.result({ status: "ok", value: ":g" });
  s.model.historyPrev();
  s.expectEq(s.state.pending, ["def g", "2"], "multi-line recall pending");
  s.expectEq(s.state.line, "end", "multi-line recall line");
  // an edit ends recall mode; non-empty pending then blocks recall
  s.model.setLine("zz");
  s.model.historyPrev();
  s.expectEq(s.state.line, "zz", "no recall over edited pending");
  s.expectEq(s.state.pending, ["def g", "2"], "pending kept");
  s.finish();
});

test("C07 error/syntax/exited/unavailable", async () => {
  const s = new Scn("C07", "error renderings", "error, syntax, exited, unavailable");
  s.model.setLine("nope");
  await s.model.enter();
  s.result({ status: "error", class: "NameError", message: "undefined local variable", backtrace: ["(rls):1"], syntax: false });
  s.expectEq(s.state.items[s.state.items.length - 1], {
    kind: "error", cls: "NameError", message: "undefined local variable",
    backtrace: ["(rls):1"], syntax: false,
  }, "error item");
  s.expectEq(s.state.mode, "idle", "idle after error");
  s.model.setLine("1 +* 2");
  await s.model.enter();
  s.result({ status: "error", class: "SyntaxError", message: "(rls):1: syntax error\n  1 +* 2\n     ^", syntax: true });
  const it = s.state.items[s.state.items.length - 1] as Extract<Item, { kind: "error" }>;
  s.expectTrue(it.kind === "error" && it.syntax && it.cls === "SyntaxError", "syntax item");
  s.model.setLine("exit 3");
  await s.model.enter();
  s.result({ status: "exited", exitCode: 3 });
  s.expectTrue(notices(s).some((t) => t.includes("Ruby exited (status 3)")), "exited 3 notice");
  s.started(2);
  s.model.setLine("x");
  await s.model.enter();
  s.result({ status: "exited", signal: 9 });
  s.expectTrue(notices(s).some((t) => t.includes("Ruby exited (signal 9)")), "signal 9 notice");
  s.model.onEvent({ type: "unavailable", message: "spawn failed" });
  s.expectTrue(notices(s).some((t) => t === "Ruby is unavailable: spawn failed"), "unavailable notice");
  s.expectEq(s.state.mode, "unavailable", "mode unavailable");
  s.finish();
});

test("C08 paste sequences checks", async () => {
  const s = new Scn("C08", "paste", "later lines wait for results; ctrl-C aborts");
  const p = s.model.paste("", "x = 1\ny = 2\nx +", "");
  await tick(); await tick(); await tick();
  s.expectEq(s.calls.filter((c) => c.op === "check").map((c) => c.arg), ["x = 1\n"], "first check only");
  s.result({ status: "ok", value: "1" });
  await tick(); await tick(); await tick();
  s.expectEq(s.calls.filter((c) => c.op === "check").map((c) => c.arg), ["x = 1\n", "y = 2\n"], "second check after result");
  s.result({ status: "ok", value: "2" });
  await p;
  s.expectEq(s.state.line, "x +", "last segment stays in line");
  // mid-paste ctrl-C aborts
  const s2 = new Scn("C08b", "paste abort", "ctrl-C mid-paste stops remaining lines");
  s2.interruptImpl = async () => "interrupt";
  const p2 = s2.model.paste("", "p1\np2\np3", "");
  await tick(); await tick(); await tick();
  await s2.model.ctrlC(); // busy -> interrupt; sets abort
  s2.result({ status: "interrupted" });
  await p2;
  s2.expectEq(s2.calls.filter((c) => c.op === "check").map((c) => c.arg), ["p1\n"], "aborted after first");
  s2.expectTrue(!itemsOf(s2, "input").some((i) => (i as { text: string }).text === "p3"), "p3 never entered");
  s2.finish();
  s.finish();
});

test("C09 output merge, ansi, cap", () => {
  const s = new Scn("C09", "output handling", "merge same stream, strip ansi, 2MB cap");
  s.model.onEvent({ type: "output", stream: "stdout", text: "he" });
  s.model.onEvent({ type: "output", stream: "stdout", text: "llo" });
  s.model.onEvent({ type: "output", stream: "stderr", text: "e1" });
  s.model.onEvent({ type: "output", stream: "stdout", text: "b" });
  s.expectEq(
    s.state.items.filter((i) => i.kind === "stdout" || i.kind === "stderr"),
    [
      { kind: "stdout", text: "hello" },
      { kind: "stderr", text: "e1" },
      { kind: "stdout", text: "b" },
    ],
    "merge/split",
  );
  s.model.onEvent({ type: "output", stream: "stdout", text: "\x1b[31mred\x1b[0m" });
  s.expectEq(s.state.items[s.state.items.length - 1], { kind: "stdout", text: "bred" }, "ansi stripped");
  s.model.onEvent({ type: "output", stream: "stdout", text: "y".repeat(2_500_000) });
  const total = s.state.items.reduce((n, i) => n + ("text" in i ? i.text.length : 0), 0);
  s.expectTrue(total <= 2_000_000, `cap holds (${total})`);
  s.finish();
});

test("C10 blank enter", async () => {
  const s = new Scn("C10", "blank enter", "no check without pending; checks with pending");
  await s.model.enter();
  s.expectEq(s.state.items[s.state.items.length - 1], { kind: "input", prompt: "rb> ", text: "" }, "blank item");
  s.expectEq(s.calls.filter((c) => c.op === "check").length, 0, "no check");
  s.checkImpl = async () => false;
  s.model.setLine("def f");
  await s.model.enter();
  await s.model.enter(); // blank line while pending
  s.expectEq(s.calls[s.calls.length - 1], { op: "check", arg: "def f\n\n" }, "blank checks with pending");
  s.expectEq(s.state.pending, ["def f", ""], "pending grew");
  s.finish();
});

test("C11 check reject keeps text", async () => {
  const s = new Scn("C11", "check failure", "warn notice, line kept, idle");
  s.checkImpl = async () => { throw new Error("ruby down"); };
  s.model.setLine("1 +");
  await s.model.enter();
  s.snap("after reject");
  s.expectTrue(notices(s).some((t) => t.includes("ruby down")), "warn notice");
  s.expectEq(s.state.line, "1 +", "line kept");
  s.expectEq(s.state.mode, "idle", "mode idle");
  s.finish();
});

test("C12 stale check ignored after ctrl-C", async () => {
  const s = new Scn("C12", "stale check", "ctrl-C during checking discards answer");
  const d = deferred<boolean>();
  s.checkImpl = () => d.p;
  s.model.setLine("1 + 2");
  const p = s.model.enter();
  await s.model.ctrlC(); // cancels while checking
  s.expectTrue(
    s.state.items.some((i) => i.kind === "input" && i.cancelled && (i as { text: string }).text === "1 + 2"),
    "cancelled input flushed",
  );
  d.resolve(true);
  await p;
  s.snap("after stale resolve");
  s.expectEq(s.calls.filter((c) => c.op === "eval").length, 0, "no eval from stale check");
  s.expectEq(s.state.mode, "idle", "mode idle");
  s.finish();
});

test("C13 paste while busy feeds stdin", async () => {
  const s = new Scn("C13", "paste into running program", "each pasted line goes to stdin without waiting for the eval to finish");
  s.model.onEvent({ type: "started", generation: 1, version: "ruby test" });
  s.model.setLine("while (l = gets) do puts l end");
  await s.model.enter();
  s.expectEq(s.state.mode, "busy", "busy after eval");
  await s.model.paste("", "a\nb\nc", "");
  s.expectEq(s.calls.filter((c) => c.op === "stdin").map((c) => c.arg), ["a\n", "b\n"], "stdin lines sent");
  s.expectEq(s.state.line, "c", "last segment stays in line");
  s.expectEq(s.state.mode, "busy", "still busy");
  s.finish();
});
