import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapStreamLine } from "../src/stream.ts";

const fixture = new URL("../../forwarder/test/fixtures/stream.jsonl", import.meta.url);
const [init, text, bash, toolOk, toolErr, result] = readFileSync(fixture, "utf8")
  .split("\n")
  .filter(Boolean) as [string, string, string, string, string, string];
const l = { init, text, bash, toolOk, toolErr, result };

const assistant = (...content: object[]) =>
  JSON.stringify({ type: "assistant", message: { content } });
const toolUse = (name: string, input: unknown) => assistant({ type: "tool_use", name, input });
const toolResult = (content: unknown, extra: object = {}) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content, ...extra }] },
  });

describe("mapStreamLine", () => {
  it("init", () =>
    expect(mapStreamLine(l.init)).toEqual([
      { kind: "system", text: "session started · model test-model" },
    ]));
  it("init without a model", () =>
    expect(mapStreamLine('{"type":"system","subtype":"init"}')).toEqual([
      { kind: "system", text: "session started" },
    ]));
  it("text", () =>
    expect(mapStreamLine(l.text)).toEqual([{ kind: "say", text: "Starting the app." }]));
  it("bash tool", () =>
    expect(mapStreamLine(l.bash)).toEqual([{ kind: "tool", text: "Bash go run ." }]));
  it("tool result", () =>
    expect(mapStreamLine(l.toolOk)).toEqual([{ kind: "tool_result", text: "listening on :8080" }]));
  it("tool error", () => expect(mapStreamLine(l.toolErr)[0]?.kind).toBe("error"));
  it("result", () =>
    expect(mapStreamLine(l.result)).toEqual([{ kind: "done", text: "success · 12 turns · 84s" }]));
  it("invalid line", () => expect(mapStreamLine("{nope")).toEqual([]));

  it("caps text at 2000 unless full", () => {
    const long = assistant({ type: "text", text: "x".repeat(3000) });
    expect(mapStreamLine(long)[0]?.text).toHaveLength(2000);
    expect(mapStreamLine(long, { full: true })[0]?.text.length).toBeGreaterThan(2000);
  });

  it.each(["null", "123", '"text"', "[]", "{}", '{"type":"rate_limit_event"}'])(
    "ignores %s",
    (line) => expect(mapStreamLine(line)).toEqual([]),
  );

  it("ignores system lines other than init", () =>
    expect(mapStreamLine('{"type":"system","subtype":"hook_started"}')).toEqual([]));

  it("trims text and skips blank text and thinking", () => {
    const line = assistant(
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "  \n " },
      { type: "text", text: "\n Done.  \n" },
    );
    expect(mapStreamLine(line)).toEqual([{ kind: "say", text: "Done." }]);
  });

  it("maps every block of a message in order", () => {
    const line = assistant(
      { type: "text", text: "Checking." },
      { type: "tool_use", name: "Read", input: { file_path: "/r/main.go" } },
    );
    expect(mapStreamLine(line)).toEqual([
      { kind: "say", text: "Checking." },
      { kind: "tool", text: "Read /r/main.go" },
    ]);
  });

  it.each([
    ["Read", { file_path: "/r/a.go" }, "Read /r/a.go"],
    ["Write", { file_path: "/r/b.go", content: "x" }, "Write /r/b.go"],
    ["Edit", { file_path: "/r/c.go", old_string: "a" }, "Edit /r/c.go"],
    ["Grep", { pattern: "TODO", path: "." }, "Grep TODO"],
    ["Glob", { pattern: "**/*.go" }, "Glob **/*.go"],
    ["WebFetch", { url: "https://x.test" }, 'WebFetch {"url":"https://x.test"}'],
    ["Bash", { cmd: "ls" }, 'Bash {"cmd":"ls"}'],
    ["constructor", {}, "constructor {}"],
  ])("summarises %s input", (name, input, expected) =>
    expect(mapStreamLine(toolUse(name, input))).toEqual([{ kind: "tool", text: expected }]),
  );

  it("cuts a JSON tool summary at 200 chars unless full", () => {
    const input = { prompt: "p".repeat(500) };
    const json = JSON.stringify(input);
    expect(mapStreamLine(toolUse("Task", input))[0]?.text).toBe(`Task ${json.slice(0, 200)}`);
    expect(mapStreamLine(toolUse("Task", input), { full: true })[0]?.text).toBe(`Task ${json}`);
  });

  it("keeps the first 300 chars of a tool result unless full", () => {
    const line = toolResult("r".repeat(1000));
    expect(mapStreamLine(line)[0]?.text).toHaveLength(300);
    expect(mapStreamLine(line, { full: true })[0]?.text).toHaveLength(1000);
  });

  it("joins the text parts of a structured tool result", () => {
    const line = toolResult([
      { type: "text", text: "one" },
      { type: "image" },
      { type: "text", text: "two" },
    ]);
    expect(mapStreamLine(line)).toEqual([{ kind: "tool_result", text: "one\ntwo" }]);
  });

  it("reports a failed result as an error", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 30,
      duration_ms: 1499,
    });
    expect(mapStreamLine(line)).toEqual([
      { kind: "error", text: "error_max_turns · 30 turns · 1s" },
    ]);
  });

  it("does not call a failed run a success", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      num_turns: 1,
      duration_ms: 2100,
    });
    expect(mapStreamLine(line)).toEqual([{ kind: "error", text: "failed · 1 turns · 2s" }]);
  });

  it("leaves out the figures a result does not carry", () =>
    expect(mapStreamLine('{"type":"result","subtype":"success"}')).toEqual([
      { kind: "done", text: "success" },
    ]));
});
