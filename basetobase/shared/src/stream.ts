import type { EventKind } from "./types.ts";

export const EVENT_TEXT_MAX = 2000;
const TOOL_RESULT_MAX = 300;
const TOOL_INPUT_MAX = 200;

// The input field that says what a tool call is about; any other tool is shown as its JSON input.
const TOOL_SUBJECT = new Map([
  ["Bash", "command"],
  ["Read", "file_path"],
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["Grep", "pattern"],
  ["Glob", "pattern"],
]);

type Mapped = { kind: EventKind; text: string };
type Fields = Record<string, unknown>;
type Cap = (text: string, max: number) => string;

// One line of `claude -p --output-format stream-json` as log events. `full` lifts every cap, for
// showing a whole transcript.
export function mapStreamLine(line: string, o: { full?: boolean } = {}): Mapped[] {
  const message = parseLine(line);
  if (!message) return [];
  const cap: Cap = (text, max) => (o.full ? text : text.slice(0, max));
  return mapMessage(message, cap).map(({ kind, text }) => ({
    kind,
    text: cap(text, EVENT_TEXT_MAX),
  }));
}

function mapMessage(message: Fields, cap: Cap): Mapped[] {
  switch (message.type) {
    case "system":
      return message.subtype === "init" ? [mapInit(message)] : [];
    case "assistant":
      return contentBlocks(message).flatMap((block) => mapAssistantBlock(block, cap));
    case "user":
      return contentBlocks(message).flatMap((block) => mapToolResult(block, cap));
    case "result":
      return [mapResult(message)];
    default:
      return [];
  }
}

function mapInit(message: Fields): Mapped {
  const model = typeof message.model === "string" ? ` · model ${message.model}` : "";
  return { kind: "system", text: `session started${model}` };
}

function mapAssistantBlock(block: Fields, cap: Cap): Mapped[] {
  if (block.type === "text" && typeof block.text === "string") {
    const text = block.text.trim();
    return text ? [{ kind: "say", text }] : [];
  }
  if (block.type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "tool";
    return [{ kind: "tool", text: `${name} ${toolSubject(name, block.input, cap)}` }];
  }
  return [];
}

function toolSubject(name: string, input: unknown, cap: Cap): string {
  const field = TOOL_SUBJECT.get(name);
  const subject = field === undefined ? undefined : asFields(input)?.[field];
  return typeof subject === "string" ? subject : cap(JSON.stringify(input) ?? "", TOOL_INPUT_MAX);
}

function mapToolResult(block: Fields, cap: Cap): Mapped[] {
  if (block.type !== "tool_result") return [];
  const kind = block.is_error === true ? "error" : "tool_result";
  return [{ kind, text: cap(resultText(block.content), TOOL_RESULT_MAX) }];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asFields(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function mapResult(message: Fields): Mapped {
  const parts = [typeof message.subtype === "string" ? message.subtype : "result"];
  if (typeof message.num_turns === "number") parts.push(`${message.num_turns} turns`);
  if (typeof message.duration_ms === "number") {
    parts.push(`${Math.round(message.duration_ms / 1000)}s`);
  }
  return { kind: message.is_error === true ? "error" : "done", text: parts.join(" · ") };
}

function contentBlocks(message: Fields): Fields[] {
  const content = asFields(message.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asFields).filter((block): block is Fields => block !== undefined);
}

function parseLine(line: string): Fields | undefined {
  try {
    return asFields(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asFields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}
