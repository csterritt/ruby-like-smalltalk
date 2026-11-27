import { expect, test } from "bun:test";
import { editorText } from "../src/editor";
import {
  ConsoleModel,
  initialState,
  type Backend,
  type RubyEvent,
} from "../src/console";

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

test("editorText picks code, then 'name = text', then text", () => {
  expect(
    editorText("locals", { name: "x", text: "14", code: "x = 14", stale: false }),
  ).toBe("x = 14");
  expect(
    editorText("locals", { name: "o", text: "#<Object>", stale: false }),
  ).toBe("o = #<Object>");
  expect(
    editorText("ivars", { name: "@s", text: "10", stale: false }),
  ).toBe("@s = 10");
  expect(
    editorText("classes", { name: "Bar", text: "class Bar", stale: false }),
  ).toBe("class Bar");
  expect(
    editorText("methods", {
      name: "sq",
      text: "def sq(n) = n * n",
      code: "def sq(n) = n * n",
      stale: false,
    }),
  ).toBe("def sq(n) = n * n");
});

test("submit ok resolves {ok:true}, evals code, echoes input", async () => {
  const calls: string[] = [];
  const m = mk({
    ...backend,
    eval: async (code) => {
      calls.push(code);
      return 1;
    },
  });
  const p = m.submit("x = 1");
  expect(m.state.mode).toBe("busy");
  result(m, { status: "ok", value: "1" });
  expect(await p).toEqual({ ok: true });
  expect(calls).toEqual(["x = 1\n"]);
  const inputs = m.state.items.filter((i) => i.kind === "input");
  expect(inputs[inputs.length - 1]).toEqual({
    kind: "input",
    prompt: "rb> ",
    text: "x = 1",
  });
});

test("submit error formats class: message + backtrace frames", async () => {
  const m = mk();
  const p = m.submit("foo");
  result(m, {
    status: "error",
    class: "NameError",
    message: "undefined local variable",
    backtrace: ["(rls):1", "(rls):2", "(rls):3", "(rls):4"],
  });
  expect(await p).toEqual({
    ok: false,
    error:
      "NameError: undefined local variable\n  from (rls):1\n  from (rls):2\n  from (rls):3",
  });
});

test("submit syntax error returns just the message", async () => {
  const m = mk();
  const p = m.submit("1 +* 2");
  result(m, {
    status: "error",
    class: "SyntaxError",
    message: "(rls):1: syntax error\n  1 +* 2\n     ^",
    syntax: true,
    backtrace: ["(rls):1"],
  });
  expect(await p).toEqual({
    ok: false,
    error: "(rls):1: syntax error\n  1 +* 2\n     ^",
  });
});

test("submit while busy fails without eval", async () => {
  let evals = 0;
  const m = mk({ ...backend, eval: async () => (++evals, 1) });
  m.setLine("sleep 1");
  await m.enter();
  evals = 0;
  expect(await m.submit("x = 1")).toEqual({
    ok: false,
    error: "Ruby is busy; try again when it's idle.",
  });
  expect(evals).toBe(0);
});

test("submit with pending entry fails without eval", async () => {
  let evals = 0;
  const m = mk({
    ...backend,
    check: async () => false,
    eval: async () => (++evals, 1),
  });
  m.setLine("def f");
  await m.enter();
  expect(await m.submit("x = 1")).toEqual({
    ok: false,
    error: "Finish or cancel the current console entry first.",
  });
  expect(evals).toBe(0);
});

test("submit resolves on killed", async () => {
  const m = mk();
  const p = m.submit("loop {}");
  result(m, { status: "killed" });
  expect(await p).toEqual({
    ok: false,
    error: "Ruby stopped; a fresh session is starting.",
  });
});

test("submit fails when backend.eval rejects", async () => {
  const m = mk({
    ...backend,
    eval: async () => {
      throw new Error("ruby down");
    },
  });
  expect(await m.submit("x = 1")).toEqual({ ok: false, error: "Error: ruby down" });
});
