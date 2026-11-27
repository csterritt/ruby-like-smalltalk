import { expect, test } from "bun:test";
import {
  emptyPanes,
  mergePanes,
  previewLines,
  staleAll,
  type Entry,
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

function panes(locals: PaneEntry[]): Panes {
  return { ...emptyPanes(), locals };
}

function snapOf(locals: Entry[]): Snapshot {
  return { locals, ivars: [], classes: [], methods: [] };
}

test("mergePanes updates, stales, appends, revives, keeps order", () => {
  const prev = panes([
    { name: "a", text: "1", code: "a = 1", stale: false },
    { name: "b", text: "2", code: "b = 2", stale: false },
    { name: "c", text: "3", code: "c = 3", stale: true },
  ]);
  const snap = snapOf([
    { name: "c", text: "33", code: "c = 33" },
    { name: "a", text: "10", code: "a = 10" },
    { name: "d", text: "4", code: "d = 4" },
  ]);
  expect(mergePanes(prev, snap).locals).toEqual([
    { name: "a", text: "10", code: "a = 10", stale: false },
    { name: "b", text: "2", code: "b = 2", stale: true },
    { name: "c", text: "33", code: "c = 33", stale: false },
    { name: "d", text: "4", code: "d = 4", stale: false },
  ]);
});

test("staleAll marks everything stale", () => {
  const prev = panes([
    { name: "a", text: "1", code: "a = 1", stale: false },
    { name: "b", text: "2", stale: true },
  ]);
  expect(staleAll(prev).locals).toEqual([
    { name: "a", text: "1", code: "a = 1", stale: true },
    { name: "b", text: "2", stale: true },
  ]);
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
  result(m, { snapshot: snapOf([{ name: "x", text: "14", code: "x = 14" }]) });
  expect(m.state.panes.locals).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: false },
  ]);
  result(m, { snapshot: snapOf([]) });
  expect(m.state.panes.locals).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: true },
  ]);
});

test("result without snapshot keeps panes", () => {
  const m = mk();
  result(m, { snapshot: snapOf([{ name: "x", text: "14" }]) });
  result(m, { status: "error", class: "NameError", message: "x" });
  expect(m.state.panes.locals).toEqual([{ name: "x", text: "14", stale: false }]);
});

test("killed / exited / started gen 2 mark stale, not removed; revive on reappear", () => {
  const m = mk();
  result(m, { snapshot: snapOf([{ name: "x", text: "14", code: "x = 14" }]) });
  result(m, { status: "killed" });
  expect(m.state.panes.locals).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: true },
  ]);
  m.onEvent({ type: "started", generation: 2, version: "ruby" });
  expect(m.state.panes.locals).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: true },
  ]);
  result(m, { snapshot: snapOf([{ name: "x", text: "14", code: "x = 14" }]) });
  expect(m.state.panes.locals).toEqual([
    { name: "x", text: "14", code: "x = 14", stale: false },
  ]);

  const m2 = mk();
  result(m2, { snapshot: snapOf([{ name: "y", text: "1" }]) });
  result(m2, { status: "exited", exitCode: 0 });
  expect(m2.state.panes.locals).toEqual([{ name: "y", text: "1", stale: true }]);
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
