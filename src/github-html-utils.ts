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
  let quote: string | undefined;
  // An unmatched "<" starts malformed markup; drop that tail instead of returning an active tag.
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (!insideTag) {
      if (character !== "<") {
        text += character;
        continue;
      }
      if (value.startsWith("<!--", index)) {
        const end = value.indexOf("-->", index + 4);
        if (end === -1) break;
        index = end + 2;
        continue;
      }
      insideTag = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      insideTag = false;
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

// HTML numeric references use Windows-1252 replacements for these C1 values.
const NUMERIC_ENTITY_REPLACEMENTS: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x2c6,
  0x89: 0x2030,
  0x8a: 0x160,
  0x8b: 0x2039,
  0x8c: 0x152,
  0x8e: 0x17d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x2dc,
  0x99: 0x2122,
  0x9a: 0x161,
  0x9b: 0x203a,
  0x9c: 0x153,
  0x9e: 0x17e,
  0x9f: 0x178,
};

function numericEntity(codePoint: number): string {
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(NUMERIC_ENTITY_REPLACEMENTS[codePoint] ?? codePoint);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
