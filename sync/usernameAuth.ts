/**
 * ECHO — username → Supabase Auth identifier adapter (1.3.0 owner decision).
 *
 * Product contract: accounts are USERNAME + PASSWORD ONLY. No email address,
 * no phone number, no Google/GitHub/social sign-in, no magic link, no SMTP,
 * and no password recovery. Supabase Auth (GoTrue) does not expose a native
 * username sign-in — its password identity is bound to an email OR phone
 * identifier (https://supabase.com/docs/guides/auth/passwords) — so this
 * module derives a deterministic, opaque INTERNAL ALIAS under the RFC 2606
 * reserved `.invalid` domain (https://www.rfc-editor.org/rfc/rfc2606.html):
 *
 *   alias = "echo-u-" + hex(SHA-256(canonical username))[0..32] + "@echo.invalid"
 *
 * Properties (each locked by tests):
 *   - deterministic: the same username always maps to the same alias, on
 *     every device, forever (no per-install randomness).
 *   - canonical: usernames are NFC-normalized and case-folded first, so
 *     "Ahmed", "ahmed", and "AHMED" are ONE account (case-insensitive).
 *   - opaque: the alias is a hash — it leaks nothing about the username and
 *     cannot be reversed; two similar usernames do not produce similar
 *     aliases, and hash collisions over the 128-bit prefix are beyond
 *     astronomical (2^-64 birthday bound at ~4 billion accounts).
 *   - non-deliverable: `.invalid` is reserved for names that are sure to be
 *     invalid; no mail can ever be sent to it, so nothing can accidentally
 *     depend on a mailbox existing.
 *   - never user-facing: ECHO never displays, asks for, remembers, or
 *     derives meaning from the alias. The ONLY places it exists are (a) the
 *     argument to supabase-js auth calls and (b) the session record that
 *     supabase-js itself persists under its own storage key. It is an
 *     internal implementation detail, not a real address and NOT a verified
 *     email — ECHO never claims the user verified anything.
 *
 * Required hosted Auth configuration (owner action, documented in
 * ECHO_HUMAN_HANDOFF/SUPABASE_SETUP.md): "Confirm email" DISABLED — with
 * confirmations off, Supabase treats the identifier as not needing
 * verification and creates the user directly; no outbound mail is attempted
 * because no mail transport is configured and the domain is non-routable.
 *
 * If the hosted Auth service rejects this pattern in practice, the adapter
 * must NOT ship: the fallback is documented in the handoff (report the
 * exact limitation; do not silently switch users to email sign-in).
 */

/** RFC 2606 reserved domain — guaranteed non-routable, never a real mailbox. */
export const AUTH_ALIAS_DOMAIN = "echo.invalid";

/** Canonical form: NFC normalization + case folding + trim. */
export function canonicalizeUsername(raw: string): string {
  return raw.normalize("NFC").toLocaleLowerCase("en-US").trim();
}

/**
 * The documented username policy: 3–32 characters; lowercase letters,
 * digits, and underscores after canonicalization (Arabic letters are
 * deliberately NOT allowed in usernames: they case-fold ambiguously across
 * platforms; the UI offers transliteration guidance instead).
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
const USERNAME_RE = /^[a-z0-9_]+$/;

/** Reserved names that can never be registered (impersonation/confusion). */
export const RESERVED_USERNAMES: readonly string[] = [
  "admin", "administrator", "root", "system", "support", "help", "moderator",
  "echo", "echoteam", "official", "staff", "security", "noreply", "no_reply",
  "null", "undefined", "me", "self", "user", "username", "test", "guest",
  "anonymous", "anon", "api", "owner", "mod", "everyone", "all", "settings",
];

export type UsernamePolicyResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: "too_short" | "too_long" | "charset" | "reserved" };

export function validateUsernamePolicy(raw: string): UsernamePolicyResult {
  const canonical = canonicalizeUsername(raw);
  if (!USERNAME_RE.test(canonical)) return { ok: false, reason: "charset" };
  // reserved names are rejected by NAME regardless of length ("me" is
  // reserved, not merely short) — the more specific error wins
  if (RESERVED_USERNAMES.includes(canonical)) return { ok: false, reason: "reserved" };
  if (canonical.length < USERNAME_MIN) return { ok: false, reason: "too_short" };
  if (canonical.length > USERNAME_MAX) return { ok: false, reason: "too_long" };
  return { ok: true, canonical };
}

/**
 * The documented password policy: 8–128 characters, no composition rules
 * (length is the dominant factor; invented rules push users to weaker
 * patterns). Supabase Auth enforces its own minimum (6 by default) — ECHO's
 * floor of 8 is deliberately stricter client-side.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function validatePasswordPolicy(password: string): boolean {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN &&
    password.length <= PASSWORD_MAX
  );
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive the internal Supabase Auth identifier for a canonical username.
 * Deterministic, opaque, collision-safe, non-deliverable (see header).
 */
export async function usernameToAuthIdentifier(canonical: string): Promise<string> {
  const hex = await sha256Hex(`echo-username-v1:${canonical}`);
  return `echo-u-${hex.slice(0, 32)}@${AUTH_ALIAS_DOMAIN}`;
}

/**
 * Sign-in vs sign-up error mapping. The distinction ECHO exposes:
 *   - sign-UP may tell the user the username is already taken (that is the
 *     product's duplicate-username contract);
 *   - sign-IN is ALWAYS a generic "wrong username or password" — never a
 *     hint about which part is wrong, and never a user-exists disclosure.
 */
export type AuthErrorCode =
  | "invalid_credentials" // generic sign-in failure
  | "username_taken" // sign-up duplicate
  | "weak_password"
  | "invalid_username"
  | "network"
  | "unknown";

/** Map a supabase-js/GoTrue error message onto the contract above. */
export function mapAuthError(message: string, phase: "signin" | "signup" | "update"): AuthErrorCode {
  const m = (message ?? "").toLowerCase();
  if (/(already (been )?registered|already exists|duplicate)/.test(m)) {
    // signup AND the anonymous→account conversion (update) may say the name
    // is taken; only plain sign-in stays generic
    return phase === "signin" ? "invalid_credentials" : "username_taken";
  }
  if (/(invalid login credentials|wrong password|invalid credentials)/.test(m)) {
    return "invalid_credentials";
  }
  if (/(password should be|password too short|weak password)/.test(m)) {
    return "weak_password";
  }
  if (/(failed to fetch|networkerror|fetch failed|timeout)/.test(m)) return "network";
  if (phase === "signin") return "invalid_credentials"; // default: generic
  return "unknown";
}
