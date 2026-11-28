/**
 * ECHO — username adapter unit tests (pure functions).
 *
 * Locks the documented contract: canonicalization, the username policy
 * (length/charset/reserved), the password policy, alias determinism /
 * opacity / collision-safety, and the sign-in-vs-sign-up error mapping.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTH_ALIAS_DOMAIN,
  canonicalizeUsername,
  usernameToAuthIdentifier,
  validateUsernamePolicy,
  validatePasswordPolicy,
  mapAuthError,
  RESERVED_USERNAMES,
} from "../../sync/usernameAuth";

describe("canonicalizeUsername", () => {
  test("case-folds and trims (one account per name, case-insensitive)", () => {
    expect(canonicalizeUsername("  Ahmed ")).toBe("ahmed");
    expect(canonicalizeUsername("AHMED")).toBe("ahmed");
    expect(canonicalizeUsername("AhMeD")).toBe("ahmed");
  });
  test("NFC-normalizes so decomposed forms are the same account", () => {
    const composed = "caf\u00e9"; // é as one code point
    const decomposed = "cafe\u0301"; // e + combining acute
    expect(canonicalizeUsername(decomposed)).toBe(canonicalizeUsername(composed));
  });
});

describe("validateUsernamePolicy", () => {
  test("accepts 3–32 chars of [a-z0-9_]", () => {
    expect(validateUsernamePolicy("abc")).toEqual({ ok: true, canonical: "abc" });
    expect(validateUsernamePolicy("User_42")).toEqual({ ok: true, canonical: "user_42" });
    expect(validateUsernamePolicy("a".repeat(32)).ok).toBe(true);
  });
  test("rejects too short / too long", () => {
    expect(validateUsernamePolicy("ab")).toEqual({ ok: false, reason: "too_short" });
    expect(validateUsernamePolicy("a".repeat(33))).toEqual({ ok: false, reason: "too_long" });
  });
  test("rejects disallowed characters (spaces, dashes, dots, Arabic letters)", () => {
    expect(validateUsernamePolicy("has space")).toEqual({ ok: false, reason: "charset" });
    expect(validateUsernamePolicy("kebab-case")).toEqual({ ok: false, reason: "charset" });
    expect(validateUsernamePolicy("dot.name")).toEqual({ ok: false, reason: "charset" });
    expect(validateUsernamePolicy("أحمد")).toEqual({ ok: false, reason: "charset" });
  });
  test("rejects every reserved name, in any case", () => {
    for (const name of RESERVED_USERNAMES) {
      expect(validateUsernamePolicy(name)).toEqual({ ok: false, reason: "reserved" });
      expect(validateUsernamePolicy(name.toUpperCase())).toEqual({ ok: false, reason: "reserved" });
    }
  });
});

describe("validatePasswordPolicy", () => {
  test("8–128 characters accepted", () => {
    expect(validatePasswordPolicy("12345678")).toBe(true);
    expect(validatePasswordPolicy("x".repeat(128))).toBe(true);
  });
  test("shorter than 8 or longer than 128 rejected", () => {
    expect(validatePasswordPolicy("1234567")).toBe(false);
    expect(validatePasswordPolicy("x".repeat(129))).toBe(false);
    expect(validatePasswordPolicy("")).toBe(false);
  });
});

describe("usernameToAuthIdentifier", () => {
  test("deterministic across calls (same username → same alias, forever)", async () => {
    const a = await usernameToAuthIdentifier("sara");
    const b = await usernameToAuthIdentifier("sara");
    expect(a).toBe(b);
  });
  test("canonical input gives one alias per username, case-insensitively", async () => {
    const lower = await usernameToAuthIdentifier(canonicalizeUsername("Sara"));
    const upper = await usernameToAuthIdentifier(canonicalizeUsername("SARA"));
    expect(lower).toBe(upper);
  });
  test("different usernames → different aliases (no collisions in practice)", async () => {
    const aliases = new Set<string>();
    for (let i = 0; i < 200; i++) {
      aliases.add(await usernameToAuthIdentifier(`user${i}`));
    }
    expect(aliases.size).toBe(200);
  });
  test("lives under the RFC 2606 reserved .invalid domain", async () => {
    const alias = await usernameToAuthIdentifier("sara");
    expect(alias.endsWith(`@${AUTH_ALIAS_DOMAIN}`)).toBe(true);
    expect(AUTH_ALIAS_DOMAIN).toBe("echo.invalid");
  });
  test("opaque: does not contain the username or readable fragments", async () => {
    const alias = await usernameToAuthIdentifier("supersecretname");
    expect(alias).not.toContain("supersecretname");
    expect(alias.startsWith("echo-u-")).toBe(true);
    // 32 hex chars of hash between the prefix and the domain
    const hashPart = alias.slice("echo-u-".length).split("@")[0];
    expect(hashPart).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("mapAuthError", () => {
  test("sign-up duplicate maps to username_taken", () => {
    expect(mapAuthError("User already registered", "signup")).toBe("username_taken");
    expect(mapAuthError("A user with this email address has already been registered", "signup"))
      .toBe("username_taken");
  });
  test("sign-in failures are ALWAYS generic — unknown user == wrong password", () => {
    expect(mapAuthError("Invalid login credentials", "signin")).toBe("invalid_credentials");
    expect(mapAuthError("User already registered", "signin")).toBe("invalid_credentials");
    expect(mapAuthError("some unexpected server error", "signin")).toBe("invalid_credentials");
  });
  test("weak password and network classes survive mapping", () => {
    expect(mapAuthError("Password should be at least 6 characters", "signup")).toBe("weak_password");
    expect(mapAuthError("Failed to fetch", "signin")).toBe("network");
    expect(mapAuthError("fetch failed", "signup")).toBe("network");
  });
});
