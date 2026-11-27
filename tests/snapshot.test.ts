import { expect, test } from "bun:test";
import {
  emptyPanes,
  mergePanes,
  previewLines,
  staleAll,
  type PaneEntry,
  type Panes,
  type Snapshot,
} from "../src/snapshot";
import {
  ConsoleModel,
  initialState,
  type Backend,
  type Item,
  type RubyEvent,
} from "../src/console";

test("previewLines short source", () => {
  expect(previewLines("def f\n  1\nend")).toEqual(["def f", "  1", "end"]);
});

test("previewLines single line", () => {
  expect(previewLines("x = 14")).toEqual(["x = 14"]);
});

test("previewLines more than 3 lines", () => {
  expect(previewLines("a\nb\nc\nd\ne")).toEqual(["a", "b", "c", "..."]);
  expect(previewLines("a\nb\nc\nd")).toEqual(["a", "b", "c", "..."]);
});

test("previewLines trims trailing blank lines", () => {
  expect(previewLines("def f\n  1\nend\n\n\n")).toEqual(["def f", "  1", "end"]);
  expect(previewLines("a\nb\nc\n\nd\n\n")).toEqual(["a", "b", "c", "..."]);
});

function panes(vars: PaneEntry[]): Panes {
  return { ...emptyPanes(), vars };
}

function snapOf(part: Partial<Snapshot>): Snapshot {
  return { locals: [], ivars: [], classes: [], methods: [], ...part };
}

test("mergePanes updates, stales, appends, revives, keeps order", () => {
  const prev = panes([
    { name: "a", text: "1", code: "a = 1", stale: false },
    { name: "b", text: "2", code: "b = 2", stale: false },
    { name: "c", text: "3", code: "c = 3", stale: true },
  ]);
  const snap = snapOf({
    locals: [
      { name: "c", text: "33", code: "c = 33" },
      { name: "a", text: "10", code: "a = 10" },
    ],
    ivars: [{ name: "d", text: "4", code: "d = 4" }],
  });
  expect(mergePanes(prev, snap).vars).toEqual([
    { name: "a", text: "10", code: "a = 10", stale: false },
    { name: "b", text: "2", code: "b = 2", stale: true },
    { name: "c", text: "33", code: "c = 33", stale: false },
    { name: "d", text: "4", code: "d = 4", stale: false },
  ]);
});

test("mergePanes requires append new, revive stale, leave absent untouched", () => {
  const prev: Panes = {
    ...emptyPanes(),
    requires: [
      { name: 'require "json"', text: 'require "json"', code: 'require "json"', stale: false },
      { name: 'require "set"', text: 'require "set"', code: 'require "set"', stale: true },
    ],
  };
  const snap = snapOf({
    requires: [
      { name: 'require "set"', text: 'require "set"', code: 'require "set"' },
      { name: 'require "csv"', text: 'require "csv"', code: 'require "csv"' },
    ],
  });
  expect(mergePanes(prev, snap).requires).toEqual([
    { name: 'require "json"', text: 'require "json"', code: 'require "json"', stale: false },
    { name: 'require "set"', text: 'require "set"', code: 'require "set"', stale: false },
    { name: 'require "csv"', text: 'require "csv"', code: 'require "csv"', stale: false },
  ]);
  // a snapshot listing no requires leaves the list alone (json not staled)
  expect(mergePanes(prev, snapOf({ requires: [] })).requires).toEqual(prev.requires);
});

test("staleAll marks everything stale incl. requires", () => {
  const prev: Panes = {
    requires: [{ name: 'require "json"', text: 'require "json"', stale: false }],
    vars: [
      { name: "a", text: "1", code: "a = 1", stale: false },
      { name: "b", text: "2", stale: true },
    ],
    classes: [],
    methods: [],
  };
  expect(staleAll(prev)).toEqual({
    requires: [{ name: 'require "json"', text: 'require "json"', stale: true }],
    vars: [
      { name: "a", text: "1", code: "a = 1", stale: true },
      { name: "b", text: "2", stale: true },
    ],
    classes: [],
    methods: [],
  });
});

const backend: Backend = {
  check: async () => true,
  eval: async () => 1,
  stdin: async () => {},
  interrupt: async () => "idle",
};

function mk(b: Backend = backend) {
  const m = new ConsoleModel(b, initialState());
  m.onEvent({ type: "started", generation: 1, version: "ruby" });
  return m;
}

function result(m: ConsoleModel, ev: Partial<Extract<RubyEvent, { type: "result" }>>) {
  m.onEvent({ type: "result", id: 1, status: "ok", ...ev } as RubyEvent);
}

function notices(m: ConsoleModel): string[] {
  return m.state.items
    .filter((i) => i.kind === "notice")
    .map((i) => (i as { text: string }).text);
}

test("result with snapshot merges; missing entries go stale", () => {
  const m = mk();
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14", code: "x = 14" }] }) });
  expect(m.state.panes.vars).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: false },
  ]);
  result(m, { snapshot: snapOf({}) });
  expect(m.state.panes.vars).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: true },
  ]);
});

test("result without snapshot keeps panes", () => {
  const m = mk();
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14" }] }) });
  result(m, { status: "error", class: "NameError", message: "x" });
  expect(m.state.panes.vars).toEqual([{ name: "x", text: "14", stale: false }]);
});

test("killed / exited / started gen 2 mark stale, not removed; revive on reappear", () => {
  const m = mk();
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14", code: "x = 14" }] }) });
  result(m, { status: "killed" });
  expect(m.state.panes.vars).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: true },
  ]);
  m.onEvent({ type: "started", generation: 2, version: "ruby" });
  expect(m.state.panes.vars).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: true },
  ]);
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14", code: "x = 14" }] }) });
  expect(m.state.panes.vars).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: false },
  ]);

  const m2 = mk();
  result(m2, { snapshot: snapOf({ locals: [{ name: "y", text: "1" }] }) });
  result(m2, { status: "exited", exitCode: 0 });
  expect(m2.state.panes.vars).toEqual([{ name: "y", text: "1", stale: true }]);
});

test("restore evals the code and echoes input lines", async () => {
  const calls: { op: string; arg: string }[] = [];
  const m = mk({
    ...backend,
    eval: async (code) => {
      calls.push({ op: "eval", arg: code });
      return 1;
    },
  });
  m.setLine("half-typed");
  await m.restore({
    name: "Foo",
    text: "class Foo\n  def a\n  end\nend",
    code: "class Foo\n  def a\n  end\nend",
    stale: true,
  });
  expect(calls).toEqual([
    { op: "eval", arg: "class Foo\n  def a\n  end\nend\n" },
  ]);
  const inputs = m.state.items.filter((i): i is Extract<Item, { kind: "input" }> => i.kind === "input");
  expect(inputs).toEqual([
    { kind: "input", prompt: "rb> ", text: "class Foo" },
    { kind: "input", prompt: "..> ", text: "  def a" },
    { kind: "input", prompt: "..> ", text: "  end" },
    { kind: "input", prompt: "..> ", text: "end" },
  ]);
  expect(m.state.line).toBe("half-typed");
  expect(m.state.mode).toBe("busy");
});

test("restore without code warns and does not eval", async () => {
  let evals = 0;
  const m = mk({ ...backend, eval: async () => (++evals, 1) });
  await m.restore({ name: "o", text: "#<Object>", stale: true });
  expect(evals).toBe(0);
  expect(notices(m).some((t) => t.includes("no Ruby source"))).toBe(true);
});

test("restore while busy warns and does not eval", async () => {
  let evals = 0;
  const m = mk({ ...backend, eval: async () => (++evals, 1) });
  m.setLine("sleep 1");
  await m.enter();
  expect(m.state.mode).toBe("busy");
  await m.restore({ name: "x", text: "14", code: "x = 14", stale: true });
  expect(evals).toBe(1); // only the sleep eval
  expect(notices(m).some((t) => t.includes("while Ruby is busy"))).toBe(true);
});

test("restore with pending entry warns and does not eval", async () => {
  let evals = 0;
  const m = mk({
    ...backend,
    check: async () => false,
    eval: async () => (++evals, 1),
  });
  m.setLine("def f");
  await m.enter();
  expect(m.state.pending).toEqual(["def f"]);
  await m.restore({ name: "x", text: "14", code: "x = 14", stale: true });
  expect(evals).toBe(0);
  expect(notices(m).some((t) => t.includes("finish or cancel"))).toBe(true);
});

test("remove stale entry removes it without eval", async () => {
  let evals = 0;
  const m = mk({ ...backend, eval: async () => (++evals, 1) });
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14", code: "x = 14" }] }) });
  result(m, { snapshot: snapOf({}) }); // x now stale
  await m.remove("vars", m.state.panes.vars[0]);
  expect(m.state.panes.vars).toEqual([]);
  expect(evals).toBe(0);
});

test("remove live local evals nil and hides it until reassigned", async () => {
  const calls: string[] = [];
  const m = mk({
    ...backend,
    eval: async (code) => {
      calls.push(code);
      return 1;
    },
  });
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14", code: "x = 14" }] }) });
  const entry = m.state.panes.vars[0];
  await m.remove("vars", entry);
  expect(m.state.panes.vars).toEqual([]);
  expect(calls).toEqual(["x = nil\n"]);
  const inputs = m.state.items.filter((i) => i.kind === "input");
  expect(inputs[inputs.length - 1]).toEqual({
    kind: "input",
    prompt: "rb> ",
    text: "x = nil",
  });
  // the follow-up snapshot still reports x = nil -> stays hidden
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "nil" }] }) });
  expect(m.state.panes.vars).toEqual([]);
  // reappears when it holds a real value again
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "5", code: "x = 5" }] }) });
  expect(m.state.panes.vars).toEqual([
    { name: "x", text: "5", code: "x = 5", stale: false },
  ]);
});

test("remove live ivar evals nil and hides it", async () => {
  const calls: string[] = [];
  const m = mk({
    ...backend,
    eval: async (code) => {
      calls.push(code);
      return 1;
    },
  });
  result(m, { snapshot: snapOf({ ivars: [{ name: "@a", text: "1", code: "@a = 1" }] }) });
  await m.remove("vars", m.state.panes.vars[0]);
  expect(m.state.panes.vars).toEqual([]);
  expect(calls).toEqual(["@a = nil\n"]);
  result(m, { snapshot: snapOf({ ivars: [{ name: "@a", text: "nil" }] }) });
  expect(m.state.panes.vars).toEqual([]);
  result(m, { snapshot: snapOf({ ivars: [{ name: "@a", text: "2" }] }) });
  expect(m.state.panes.vars).toEqual([{ name: "@a", text: "2", stale: false }]);
});

test("remove live require removes from list without eval", async () => {
  let evals = 0;
  const m = mk({ ...backend, eval: async () => (++evals, 1) });
  result(m, {
    snapshot: snapOf({
      requires: [{ name: 'require "json"', text: 'require "json"', code: 'require "json"' }],
    }),
  });
  const entry = m.state.panes.requires[0];
  expect(entry.stale).toBe(false);
  await m.remove("requires", entry);
  expect(m.state.panes.requires).toEqual([]);
  expect(evals).toBe(0);
});

test("remove codes for method and class", async () => {
  const calls: string[] = [];
  const m = mk({
    ...backend,
    eval: async (code) => {
      calls.push(code);
      return 1;
    },
  });
  result(m, {
    snapshot: snapOf({
      classes: [{ name: "Foo", text: "class Foo" }],
      methods: [{ name: "sq", text: "def sq(n) = n * n" }],
    }),
  });
  await m.remove("methods", m.state.panes.methods[0]);
  result(m, { status: "ok" }); // back to idle
  await m.remove("classes", m.state.panes.classes[0]);
  expect(calls).toEqual(["undef sq\n", "Object.send(:remove_const, :Foo)\n"]);
  expect(m.state.panes.methods).toEqual([]);
  expect(m.state.panes.classes).toEqual([]);
});

test("remove while busy or with pending warns, list unchanged", async () => {
  let evals = 0;
  const m = mk({ ...backend, eval: async () => (++evals, 1) });
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14" }] }) });
  m.setLine("sleep 1");
  await m.enter();
  evals = 0;
  await m.remove("vars", m.state.panes.vars[0]);
  expect(evals).toBe(0);
  expect(m.state.panes.vars.length).toBe(1);
  expect(notices(m).some((t) => t === "Can't remove x while Ruby is busy.")).toBe(true);

  const m2 = mk({ ...backend, check: async () => false, eval: async () => (++evals, 1) });
  result(m2, { snapshot: snapOf({ locals: [{ name: "x", text: "14" }] }) });
  m2.setLine("def f");
  await m2.enter();
  evals = 0;
  await m2.remove("vars", m2.state.panes.vars[0]);
  expect(evals).toBe(0);
  expect(m2.state.panes.vars.length).toBe(1);
  expect(notices(m2).some((t) => t === "Can't remove x: finish or cancel the current entry first.")).toBe(true);
});

test("hidden vars cleared on started generation > 1", async () => {
  const m = mk();
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "14", code: "x = 14" }] }) });
  await m.remove("vars", m.state.panes.vars[0]);
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "nil" }] }) });
  expect(m.state.panes.vars).toEqual([]);
  m.onEvent({ type: "started", generation: 2, version: "ruby" });
  result(m, { snapshot: snapOf({ locals: [{ name: "x", text: "nil" }] }) });
  expect(m.state.panes.vars).toEqual([{ name: "x", text: "nil", stale: false }]);
});
