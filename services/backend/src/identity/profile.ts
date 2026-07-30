import { IdentityError } from "./provider.js";

const BLOCKED_TERMS = [
  "admin",
  "moderator",
  "nigger",
  "nigga",
  "faggot",
  "rape",
  "whore",
] as const;
const CONTACT_OR_LINK =
  /(?:https?:\/\/|www\.|discord(?:app)?\.|@[a-z0-9_]{2,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d\s().-]{6,}\d)/iu;
const ALLOWED_CHARACTERS = /^[\p{L}\p{M}\p{N} ._'’-]+$/u;

export function normalizeDisplayName(input: string): string {
  const normalized = input.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const length = [...normalized].length;
  const folded = normalized.toLocaleLowerCase("en-US");
  const compact = folded
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/gu, "")
    .replaceAll("0", "o")
    .replaceAll("1", "i")
    .replaceAll("3", "e")
    .replaceAll("4", "a")
    .replaceAll("5", "s")
    .replaceAll("7", "t");
  const unsafe =
    length < 3 ||
    length > 24 ||
    !ALLOWED_CHARACTERS.test(normalized) ||
    CONTACT_OR_LINK.test(normalized) ||
    BLOCKED_TERMS.some(
      (term) => folded.includes(term) || compact.includes(term),
    );

  if (unsafe) {
    throw new IdentityError(
      "invalid_display_name",
      "Choose a display name without unsafe, misleading, or contact information",
      400,
    );
  }
  return normalized;
}

export function defaultDisplayName(userId: string): string {
  return `Player-${userId.replaceAll("-", "").slice(-6).toUpperCase()}`;
}
