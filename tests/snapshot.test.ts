import { expect, test } from "bun:test";
import { emptySnapshot, previewLines, type Snapshot } from "../src/snapshot";
import {
  ConsoleModel,
  initialState,
  type Backend,
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

const backend: Backend = {
  check: async () => true,
  eval: async () => 1,
  stdin: async () => {},
  interrupt: async () => "idle",
};

function mk() {
  return new ConsoleModel(backend, initialState());
}

const snap1: Snapshot = {
  locals: [{ name: "x", text: "14" }],
  ivars: [],
  classes: [],
  methods: [],
};
const snap2: Snapshot = {
  locals: [],
  ivars: [{ name: "@s", text: "10" }],
  classes: [],
  methods: [],
};

function result(m: ConsoleModel, ev: Partial<Extract<RubyEvent, { type: "result" }>>) {
  m.onEvent({ type: "result", id: 1, status: "ok", ...ev } as RubyEvent);
}

test("result with snapshot replaces state.snapshot", () => {
  const m = mk();
  expect(m.state.snapshot).toEqual(emptySnapshot());
  result(m, { snapshot: snap1 });
  expect(m.state.snapshot).toEqual(snap1);
  result(m, { snapshot: snap2 });
  expect(m.state.snapshot).toEqual(snap2);
});

test("result without snapshot keeps previous", () => {
  const m = mk();
  result(m, { snapshot: snap1 });
  result(m, { status: "error", class: "NameError", message: "x" });
  expect(m.state.snapshot).toEqual(snap1);
});

test("killed clears snapshot", () => {
  const m = mk();
  result(m, { snapshot: snap1 });
  result(m, { status: "killed" });
  expect(m.state.snapshot).toEqual(emptySnapshot());
});

test("exited clears snapshot", () => {
  const m = mk();
  result(m, { snapshot: snap1 });
  result(m, { status: "exited", exitCode: 0 });
  expect(m.state.snapshot).toEqual(emptySnapshot());
});

test("started generation > 1 clears snapshot; gen 1 keeps", () => {
  const m = mk();
  result(m, { snapshot: snap1 });
  m.onEvent({ type: "started", generation: 2, version: "ruby" });
  expect(m.state.snapshot).toEqual(emptySnapshot());

  result(m, { snapshot: snap2 });
  m.onEvent({ type: "started", generation: 1, version: "ruby" });
  expect(m.state.snapshot).toEqual(snap2);
});
