import { readBodyCapped } from "./response-body";

export async function readStringRewriteJSON(request: Request, limit: number): Promise<unknown> {
  const bytes = await readBodyCapped(
    new Response(request.body),
    limit,
    () => new Error("JSON limit exceeded"),
  );
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return parseStringRewriteJSON(text);
}

// Policy JSON must not silently accept duplicate keys or invalid Unicode.
// This bounded parser uses JSON.parse only for individual strings/numbers.
export function parseStringRewriteJSON(text: string): unknown {
  let position = 0;
  const invalid = (): never => {
    throw new Error("Invalid policy JSON");
  };
  const whitespace = () => {
    while (position < text.length && " \t\r\n".includes(text[position]!)) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === "\\") {
        position++;
      } else if (char === '"') {
        const value: unknown = JSON.parse(text.slice(start, position));
        if (typeof value !== "string" || !value.isWellFormed()) invalid();
        return value as string;
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 8) invalid();
    whitespace();
    const char = text[position];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      position++;
      const object: Record<string, unknown> = Object.create(null);
      const array: unknown[] = [];
      const closing = char === "{" ? "}" : "]";
      whitespace();
      if (text[position] !== closing) {
        for (;;) {
          whitespace();
          if (char === "{") {
            if (text[position] !== '"') invalid();
            const key = string();
            if (Object.hasOwn(object, key)) invalid();
            whitespace();
            if (text[position++] !== ":") invalid();
            object[key] = value(depth + 1);
          } else {
            array.push(value(depth + 1));
          }
          whitespace();
          if (text[position] !== ",") break;
          position++;
        }
      }
      if (text[position++] !== closing) invalid();
      return char === "{" ? object : array;
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, position)) {
        position += literal.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(position),
    );
    if (number === null) return invalid();
    position += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isFinite(parsed)) invalid();
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (position !== text.length) invalid();
  return parsed;
}
