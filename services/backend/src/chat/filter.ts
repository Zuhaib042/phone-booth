export const CHAT_NORMALIZATION_VERSION = "chat-normalization.v1";
export const CHAT_POLICY_VERSION = "chat-policy.v1";
export const MAX_TYPED_MESSAGE_CHARACTERS = 240;

export type DeterministicFilterReason =
  | "contact_details"
  | "empty"
  | "link"
  | "prohibited_harassment"
  | "prohibited_hate"
  | "prohibited_self_harm"
  | "prohibited_sexual"
  | "prohibited_threat"
  | "too_long";

export interface DeterministicFilterResult {
  readonly action: "allow" | "block";
  readonly characterCount: number;
  readonly normalizedText: string;
  readonly reasons: readonly DeterministicFilterReason[];
  readonly scanText: string;
}

const INVISIBLE_FORMATTING =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const COMBINING_MARK = /\p{Mark}/gu;
const NON_SCAN_CHARACTER = /[^\p{Letter}\p{Number}@.+]+/gu;
const NON_COMPACT_CHARACTER = /[^\p{Letter}\p{Number}]+/gu;

const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a",
  е: "e",
  і: "i",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  Α: "a",
  Β: "b",
  Ε: "e",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Χ: "x",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  μ: "m",
  ν: "n",
  ο: "o",
  ρ: "p",
  τ: "t",
  χ: "x",
};

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  $: "s",
};

const PROHIBITED_TERMS = {
  prohibited_harassment: [
    "bitch",
    "cunt",
    "fuck you",
    "motherfucker",
    "piece of shit",
  ],
  prohibited_hate: [
    "chink",
    "faggot",
    "heil hitler",
    "kike",
    "nigga",
    "nigger",
    "spic",
    "tranny",
    "white power",
  ],
  prohibited_self_harm: ["kill yourself", "kys", "self harm", "suicide"],
  prohibited_sexual: [
    "child porn",
    "explicit sex",
    "send nudes",
    "sexual minor",
  ],
  prohibited_threat: [
    "i will kill you",
    "i will murder you",
    "shoot you",
    "stab you",
  ],
} as const satisfies Readonly<
  Record<
    Exclude<
      DeterministicFilterReason,
      "contact_details" | "empty" | "link" | "too_long"
    >,
    readonly string[]
  >
>;

function replaceCharacters(
  value: string,
  replacements: Readonly<Record<string, string>>,
): string {
  return Array.from(
    value,
    (character) => replacements[character] ?? character,
  ).join("");
}

export function normalizeChatText(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
      ? ""
      : character;
  }).join("");
  return withoutControls
    .normalize("NFKC")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function chatScanText(value: string): string {
  const decomposed = normalizeChatText(value)
    .normalize("NFKD")
    .replace(COMBINING_MARK, "")
    .toLocaleLowerCase("en-US");
  return replaceCharacters(replaceCharacters(decomposed, CONFUSABLES), LEET)
    .replace(NON_SCAN_CHARACTER, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compact(value: string): string {
  return value.replace(NON_COMPACT_CHARACTER, "");
}

function includesTerm(scanText: string, term: string): boolean {
  const normalizedTerm = chatScanText(term);
  const termScanText = scanText
    .replace(/[.@+]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const paddedText = ` ${termScanText} `;
  if (paddedText.includes(` ${normalizedTerm} `)) {
    return true;
  }
  const compactTerm = compact(normalizedTerm);
  const tokens = termScanText.split(" ");
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";
    for (let end = start; end < tokens.length; end += 1) {
      joined += compact(tokens[end] as string);
      if (end > start && joined === compactTerm) {
        return true;
      }
      if (joined.length >= compactTerm.length) {
        break;
      }
    }
  }
  return false;
}

function hasLink(normalized: string, scanText: string): boolean {
  if (/(?:https?:\/\/|www\.)\S+/iu.test(normalized)) {
    return true;
  }
  return /(?:^|\s)[a-z0-9-]+(?:\s*(?:\.|\bdot\b)\s*[a-z0-9-]+)*\s*(?:\.|\bdot\b)\s*(?:app|co|com|dev|gg|io|me|net|org)(?:\s|$)/iu.test(
    scanText,
  );
}

function hasContactDetails(normalized: string, scanText: string): boolean {
  if (
    /[\p{Letter}\p{Number}._%+-]+\s*(?:@|\bat\b)\s*[\p{Letter}\p{Number}.-]+\s*(?:\.|\bdot\b)\s*[\p{Letter}]{2,}/iu.test(
      scanText,
    )
  ) {
    return true;
  }
  if (/(?:\+?\d[\s().-]*){7,}/u.test(normalized)) {
    return true;
  }
  return /\b(?:discord|instagram|signal|snapchat|telegram|whatsapp)\b/iu.test(
    scanText,
  );
}

export function filterTypedMessage(
  value: string,
  maximumCharacters = MAX_TYPED_MESSAGE_CHARACTERS,
): DeterministicFilterResult {
  const normalizedText = normalizeChatText(value);
  const scanText = chatScanText(normalizedText);
  const characterCount = Array.from(normalizedText).length;
  const reasons: DeterministicFilterReason[] = [];

  if (characterCount === 0) {
    reasons.push("empty");
  }
  if (characterCount > maximumCharacters) {
    reasons.push("too_long");
  }
  if (hasLink(normalizedText, scanText)) {
    reasons.push("link");
  }
  if (hasContactDetails(normalizedText, scanText)) {
    reasons.push("contact_details");
  }
  for (const [reason, terms] of Object.entries(PROHIBITED_TERMS) as [
    Exclude<
      DeterministicFilterReason,
      "contact_details" | "empty" | "link" | "too_long"
    >,
    readonly string[],
  ][]) {
    if (terms.some((term) => includesTerm(scanText, term))) {
      reasons.push(reason);
    }
  }

  return {
    action: reasons.length === 0 ? "allow" : "block",
    characterCount,
    normalizedText,
    reasons: [...new Set(reasons)],
    scanText,
  };
}
