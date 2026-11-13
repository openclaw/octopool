export function plainHTML(value: string): string {
  return decodeHTML(stripHTMLTags(value)).trim();
}

export function htmlAttribute(attributes: string, name: string): string | undefined {
  const value = new RegExp(`(?:^|\\s)${escapeRegex(name)}="([^"]*)"`).exec(attributes)?.[1];
  return value === undefined || value === "" ? undefined : decodeHTML(value);
}

export function textMatch(input: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(input)?.[1];
  return value === undefined ? undefined : plainHTML(value);
}

export function stripHTMLTags(value: string): string {
  let text = "";
  let insideTag = false;
  // An unmatched "<" starts malformed markup; drop that tail instead of returning an active tag.
  for (const character of value) {
    if (character === "<") {
      insideTag = true;
    } else if (character === ">" && insideTag) {
      insideTag = false;
    } else if (!insideTag) {
      text += character;
    }
  }
  return text;
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', lt: "<", gt: ">", amp: "&" };

export function decodeHTML(value: string): string {
  // Decode original references once; replacement text must not become another entity.
  return value.replace(
    /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));|&(quot|lt|gt|amp);/g,
    (match, hex: string | undefined, decimal: string | undefined, named: string) => {
      if (hex !== undefined) return numericEntity(Number.parseInt(hex, 16));
      if (decimal !== undefined) return numericEntity(Number(decimal));
      return NAMED_ENTITIES[named] ?? match;
    },
  );
}

function numericEntity(codePoint: number): string {
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\uFFFD";
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
