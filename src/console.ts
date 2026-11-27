import { emptyPanes, mergePanes, staleAll, type PaneEntry, type Panes, type Snapshot } from "./snapshot";

export type RubyEvent =
  | { type: "started"; generation: number; version: string }
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | {
      type: "result";
      id: number;
      status: "ok" | "error" | "interrupted" | "killed" | "exited";
      value?: string;
      class?: string;
      message?: string;
      backtrace?: string[];
      syntax?: boolean;
      exitCode?: number;
      signal?: number;
      snapshot?: Snapshot;
    }
  | { type: "exited"; generation: number; exitCode?: number; signal?: number; reason: string }
  | { type: "unavailable"; message: string };

export type SubmitResult = { ok: true } | { ok: false; error: string };

export interface Backend {
  check(code: string): Promise<boolean>;
  eval(code: string): Promise<number>;
  stdin(text: string): Promise<void>;
  interrupt(): Promise<"idle" | "interrupt" | "kill">;
}

export type Item =
  | { kind: "input"; prompt: "rb> " | "..> "; text: string; cancelled?: boolean }
  | { kind: "stdin"; text: string }
  | { kind: "stdout" | "stderr"; text: string }
  | { kind: "value"; text: string }
  | { kind: "error"; cls: string; message: string; backtrace: string[]; syntax: boolean }
  | { kind: "notice"; tone: "info" | "warn"; text: string };

export interface ConsoleState {
  items: Item[];
  pending: string[];
  line: string;
  mode: "starting" | "idle" | "checking" | "busy" | "unavailable";
  version: string | null;
  panes: Panes;
}

export function initialState(): ConsoleState {
  return {
    items: [],
    pending: [],
    line: "",
    mode: "starting",
    version: null,
    panes: emptyPanes(),
  };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const MAX_ITEM_CHARS = 2_000_000;
const MAX_ITEMS = 5_000;
const HISTORY_MAX = 500;
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
  return s.replace(OSC, "").replace(CSI, "");
}

function itemChars(it: Item): number {
  switch (it.kind) {
    case "input":
      return it.prompt.length + it.text.length + (it.cancelled ? 2 : 0);
    case "error":
      return it.cls.length + it.message.length + it.backtrace.reduce((n, f) => n + f.length, 0);
    default:
      return it.text.length;
  }
}

export class ConsoleModel {
  readonly state: ConsoleState;
  private backend: Backend;
  private timers: Timers;
  private history: string[][] = [];
  private historyIdx: number | null = null;
  private recalling = false;
  private draft: { pending: string[]; line: string } | null = null;
  private checkSeq = 0;
  private evalSeq = 0;
  private stillTimer: unknown = null;
  private modeWaiters: Array<() => void> = [];
  private pasteAbort = false;

  constructor(backend: Backend, state: ConsoleState, timers?: Timers) {
    this.backend = backend;
    this.state = state;
    this.timers = timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as number),
    };
  }

  get prompt(): "rb> " | "..> " | "" {
    if (this.state.mode === "busy") return "";
    return this.state.pending.length > 0 ? "..> " : "rb> ";
  }

  private setMode(mode: ConsoleState["mode"]) {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    const waiters = this.modeWaiters;
    this.modeWaiters = [];
    for (const w of waiters) w();
  }

  private waitForIdle(): Promise<void> {
    if (this.state.mode !== "busy") return Promise.resolve();
    return new Promise((resolve) => this.modeWaiters.push(resolve));
  }

  private clearStillTimer() {
    if (this.stillTimer !== null) {
      this.timers.clearTimeout(this.stillTimer);
      this.stillTimer = null;
    }
  }

  private pushItem(item: Item) {
    this.state.items.push(item);
    this.enforceCaps();
  }

  private flushEntry(cancelled: boolean) {
    const lines = [...this.state.pending, this.state.line];
    lines.forEach((text, i) => {
      this.state.items.push({
        kind: "input",
        prompt: i === 0 ? "rb> " : "..> ",
        text,
        cancelled: cancelled && i === lines.length - 1 ? true : undefined,
      });
    });
    this.state.pending = [];
    this.state.line = "";
    this.enforceCaps();
  }

  async enter(): Promise<void> {
    const st = this.state;
    if (st.mode === "starting" || st.mode === "unavailable" || st.mode === "checking") return;
    this.endRecall();
    if (st.mode === "busy") {
      const text = st.line;
      this.pushItem({ kind: "stdin", text });
      st.line = "";
      try {
        await this.backend.stdin(text + "\n");
      } catch (e) {
        this.pushItem({ kind: "notice", tone: "warn", text: String(e) });
      }
      return;
    }
    // idle
    if (st.pending.length === 0 && st.line.trim() === "") {
      this.pushItem({ kind: "input", prompt: "rb> ", text: "" });
      st.line = "";
      return;
    }
    const lines = [...st.pending, st.line];
    const code = lines.join("\n") + "\n";
    this.setMode("checking");
    const seq = ++this.checkSeq;
    let complete: boolean;
    try {
      complete = await this.backend.check(code);
    } catch (e) {
      this.pushItem({ kind: "notice", tone: "warn", text: String(e) });
      this.setMode("idle");
      return;
    }
    if (seq !== this.checkSeq) return; // cancelled while checking
    if (!complete) {
      st.pending.push(st.line);
      st.line = "";
      this.setMode("idle");
      return;
    }
    this.flushEntry(false);
    if (this.history[this.history.length - 1]?.join("\n") !== lines.join("\n")) {
      this.history.push(lines);
      if (this.history.length > HISTORY_MAX) this.history.shift();
    }
    this.historyIdx = null;
    this.draft = null;
    this.setMode("busy");
    const evSeq = ++this.evalSeq;
    try {
      await this.backend.eval(code);
    } catch (e) {
      this.pushItem({ kind: "notice", tone: "warn", text: String(e) });
      if (this.evalSeq === evSeq) this.setMode("idle");
    }
  }

  async ctrlC(): Promise<void> {
    const st = this.state;
    this.pasteAbort = true;
    if (st.mode === "busy") {
      const seq = this.evalSeq;
      let r: "idle" | "interrupt" | "kill";
      try {
        r = await this.backend.interrupt();
      } catch (e) {
        this.pushItem({ kind: "notice", tone: "warn", text: String(e) });
        return;
      }
      if (r === "interrupt") {
        this.pushItem({ kind: "notice", tone: "info", text: "^C" });
        this.clearStillTimer();
        this.stillTimer = this.timers.setTimeout(() => {
          this.stillTimer = null;
          if (this.state.mode === "busy" && this.evalSeq === seq) {
            this.pushItem({
              kind: "notice",
              tone: "warn",
              text: "Still running. Press Ctrl-C again to kill Ruby and start a fresh session.",
            });
          }
        }, 1000);
      }
      return;
    }
    if (st.mode === "idle" || st.mode === "checking") {
      this.checkSeq++; // ignore a stale check answer
      this.endRecall();
      this.flushEntry(true);
      this.setMode("idle");
    }
  }

  private canRecall(): boolean {
    return this.state.mode === "idle" && (this.state.pending.length === 0 || this.recalling);
  }

  historyPrev(): void {
    if (!this.canRecall() || this.history.length === 0) return;
    if (this.historyIdx === null) {
      this.draft = { pending: [...this.state.pending], line: this.state.line };
      this.historyIdx = this.history.length;
    }
    if (this.historyIdx === 0) return;
    this.historyIdx--;
    this.recall(this.history[this.historyIdx]);
  }

  historyNext(): void {
    if (!this.canRecall() || this.historyIdx === null) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.recall(this.history[this.historyIdx]);
    } else {
      const d = this.draft;
      this.historyIdx = null;
      this.draft = null;
      this.recalling = false;
      if (d) {
        this.state.pending = d.pending;
        this.state.line = d.line;
      }
    }
  }

  private recall(lines: string[]) {
    this.state.pending = lines.slice(0, -1);
    this.state.line = lines[lines.length - 1] ?? "";
    this.recalling = true;
  }

  private endRecall() {
    this.recalling = false;
    this.historyIdx = null;
    this.draft = null;
  }

  private guard(verb: string, name: string): boolean {
    const st = this.state;
    if (st.mode !== "idle") {
      this.pushItem({
        kind: "notice",
        tone: "warn",
        text: `Can't ${verb} ${name} while Ruby is busy.`,
      });
      return false;
    }
    if (st.pending.length > 0) {
      this.pushItem({
        kind: "notice",
        tone: "warn",
        text: `Can't ${verb} ${name}: finish or cancel the current entry first.`,
      });
      return false;
    }
    return true;
  }

  private async runCode(code: string): Promise<string | null> {
    this.endRecall();
    code.split("\n").forEach((text, i) => {
      this.state.items.push({
        kind: "input",
        prompt: i === 0 ? "rb> " : "..> ",
        text,
      });
    });
    this.enforceCaps();
    this.setMode("busy");
    const evSeq = ++this.evalSeq;
    try {
      await this.backend.eval(code + "\n");
      return null;
    } catch (e) {
      this.pushItem({ kind: "notice", tone: "warn", text: String(e) });
      if (this.evalSeq === evSeq) this.setMode("idle");
      return String(e);
    }
  }

  private pendingSubmit: ((r: SubmitResult) => void) | null = null;

  async submit(code: string): Promise<SubmitResult> {
    const st = this.state;
    if (st.mode !== "idle") {
      return { ok: false, error: "Ruby is busy; try again when it's idle." };
    }
    if (st.pending.length > 0) {
      return { ok: false, error: "Finish or cancel the current console entry first." };
    }
    const done = new Promise<SubmitResult>((resolve) => {
      this.pendingSubmit = resolve;
    });
    const err = await this.runCode(code);
    if (err !== null) {
      this.pendingSubmit = null;
      return { ok: false, error: err };
    }
    return done;
  }

  private resolveSubmit(ev: Extract<RubyEvent, { type: "result" }>) {
    const r = this.pendingSubmit;
    if (!r) return;
    this.pendingSubmit = null;
    switch (ev.status) {
      case "ok":
        r({ ok: true });
        break;
      case "error": {
        let error: string;
        if (ev.syntax) {
          error = ev.message ?? "";
        } else {
          error = `${ev.class ?? "Error"}: ${ev.message ?? ""}`;
          for (const f of (ev.backtrace ?? []).slice(0, 3)) {
            error += `\n  from ${f}`;
          }
        }
        r({ ok: false, error });
        break;
      }
      case "interrupted":
        r({ ok: false, error: "Interrupted" });
        break;
      case "killed":
      case "exited":
        r({ ok: false, error: "Ruby stopped; a fresh session is starting." });
        break;
    }
  }

  async restore(entry: PaneEntry): Promise<void> {
    if (!entry.code) {
      this.pushItem({
        kind: "notice",
        tone: "warn",
        text: `Can't restore ${entry.name}: no Ruby source for it was recorded.`,
      });
      return;
    }
    if (!this.guard("restore", entry.name)) return;
    await this.runCode(entry.code);
  }

  private hidden = {
    locals: new Set<string>(),
    ivars: new Set<string>(),
  };

  private filterHidden(snap: Snapshot) {
    for (const area of ["locals", "ivars"] as const) {
      const hidden = this.hidden[area];
      snap[area] = snap[area].filter((e) => {
        if (!hidden.has(e.name)) return true;
        if (e.text === "nil") return false;
        hidden.delete(e.name);
        return true;
      });
    }
  }

  private removeEntry(area: keyof Panes, name: string) {
    const st = this.state;
    st.panes = {
      ...st.panes,
      [area]: st.panes[area].filter((e) => e.name !== name),
    };
  }

  async remove(area: keyof Panes, entry: PaneEntry): Promise<void> {
    if (entry.stale) {
      this.removeEntry(area, entry.name);
      return;
    }
    if (!this.guard("remove", entry.name)) return;
    this.removeEntry(area, entry.name);
    let code: string;
    switch (area) {
      case "locals":
        this.hidden.locals.add(entry.name);
        code = `${entry.name} = nil`;
        break;
      case "ivars":
        this.hidden.ivars.add(entry.name);
        code = `${entry.name} = nil`;
        break;
      case "methods":
        code = `undef ${entry.name}`;
        break;
      case "classes":
        code = `Object.send(:remove_const, :${entry.name})`;
        break;
    }
    await this.runCode(code);
  }

  setLine(text: string) {
    this.endRecall();
    this.state.line = text;
  }

  touched() {
    this.endRecall();
  }

  async paste(before: string, text: string, after: string): Promise<void> {
    this.endRecall();
    const segs = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    this.state.line = before + segs[0];
    this.pasteAbort = false;
    for (let i = 1; i < segs.length; i++) {
      const wasBusy = this.state.mode === "busy";
      await this.enter();
      while (!wasBusy && this.state.mode === "busy") {
        await this.waitForIdle();
      }
      if (this.pasteAbort) return;
      this.state.line = segs[i];
    }
    this.state.line += after;
    this.recalling = false;
  }

  onEvent(ev: RubyEvent): void {
    const st = this.state;
    switch (ev.type) {
      case "started": {
        st.version = ev.version;
        if (ev.generation > 1) {
          st.panes = staleAll(st.panes);
          this.hidden.locals.clear();
          this.hidden.ivars.clear();
        }
        if (st.mode !== "busy") this.setMode("idle");
        if (ev.generation === 1) {
          this.pushItem({ kind: "notice", tone: "info", text: ev.version });
        } else {
          this.pushItem({ kind: "notice", tone: "info", text: `New Ruby session (${ev.version}).` });
        }
        break;
      }
      case "output": {
        const text = stripAnsi(ev.text.replace(/\r\n/g, "\n"));
        if (text === "") break;
        const last = st.items[st.items.length - 1];
        if (last && last.kind === ev.stream) {
          (last as { text: string }).text += text;
          this.enforceCaps();
        } else {
          this.pushItem({ kind: ev.stream, text });
        }
        break;
      }
      case "result": {
        this.clearStillTimer();
        if (ev.snapshot) {
          this.filterHidden(ev.snapshot);
          st.panes = mergePanes(st.panes, ev.snapshot);
        }
        switch (ev.status) {
          case "ok":
            this.pushItem({ kind: "value", text: ev.value ?? "" });
            this.setMode("idle");
            break;
          case "error":
            this.pushItem({
              kind: "error",
              cls: ev.class ?? "Error",
              message: ev.message ?? "",
              backtrace: ev.backtrace ?? [],
              syntax: ev.syntax ?? false,
            });
            this.setMode("idle");
            break;
          case "interrupted": {
            const top = ev.backtrace?.[0];
            this.pushItem({
              kind: "notice",
              tone: "warn",
              text: "Interrupted" + (top ? ` at ${top}` : ""),
            });
            this.setMode("idle");
            break;
          }
          case "killed":
            this.pushItem({
              kind: "notice",
              tone: "warn",
              text: "Ruby didn't stop on Ctrl-C, so it was killed. A fresh session is starting; earlier definitions are gone.",
            });
            st.panes = staleAll(st.panes);
            this.hidden.locals.clear();
            this.hidden.ivars.clear();
            this.setMode("starting");
            break;
          case "exited": {
            const how =
              ev.exitCode != null
                ? `status ${ev.exitCode}`
                : ev.signal != null
                  ? `signal ${ev.signal}`
                  : "unknown";
            this.pushItem({
              kind: "notice",
              tone: "warn",
              text: `Ruby exited (${how}). A fresh session is starting; earlier definitions are gone.`,
            });
            st.panes = staleAll(st.panes);
            this.hidden.locals.clear();
            this.hidden.ivars.clear();
            this.setMode("starting");
            break;
          }
        }
        this.resolveSubmit(ev);
        break;
      }
      case "unavailable":
        this.setMode("unavailable");
        this.pushItem({ kind: "notice", tone: "warn", text: `Ruby is unavailable: ${ev.message}` });
        break;
      case "exited":
        break;
    }
  }

  private enforceCaps() {
    while (this.state.items.length > MAX_ITEMS) this.state.items.shift();
    let total = this.state.items.reduce((n, it) => n + itemChars(it), 0);
    while (total > MAX_ITEM_CHARS && this.state.items.length > 0) {
      const first = this.state.items[0];
      const excess = total - MAX_ITEM_CHARS;
      if (itemChars(first) <= excess && this.state.items.length > 1) {
        this.state.items.shift();
        total -= itemChars(first);
      } else {
        if ("text" in first && typeof first.text === "string") {
          const keep = Math.max(0, first.text.length - excess);
          first.text = first.text.slice(first.text.length - keep);
        }
        total -= excess;
      }
    }
  }
}
