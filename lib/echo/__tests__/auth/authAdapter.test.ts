/**
 * ECHO — username/password adapter integration tests.
 *
 * Drives the REAL `@supabase/supabase-js` client against the local
 * GoTrue-compatible mock (gotrueMock.ts) over a real HTTP server, verifying
 * the complete account lifecycle ECHO's B1 surface implements:
 *
 *   signup → duplicate (case-insensitive) → sign-in (right/wrong/unknown)
 *   → session persistence → sign-out → anonymous bridge → in-place
 *   conversion to a permanent account → password change with current-
 *   password re-authentication → the no-recovery/no-mail boundary.
 *
 * What is verified HERE: everything up to the wire contract of the hosted
 * Auth service, using the actual client library ECHO ships.
 * What is NOT verified here: the hosted GoTrue binary's own behavior for
 * `.invalid` identifiers and the hosted "Confirm email" configuration —
 * that is the documented owner checkpoint (see ECHO_HUMAN_HANDOFF).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GoTrueMock } from "./gotrueMock";
import { SupabaseAuthClient, AuthFlowError } from "../../sync/auth";
import { usernameToAuthIdentifier } from "../../sync/usernameAuth";

let mock: GoTrueMock;
let client: SupabaseAuthClient;
let baseUrl: string;

beforeEach(async () => {
  mock = new GoTrueMock();
  baseUrl = await mock.start();
  client = new SupabaseAuthClient({ url: baseUrl, anonKey: "mock-anon-key" });
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(async () => {
  await mock.stop();
});

const PASSWORD = "correct-horse-battery";

describe("sign-up with username + password", () => {
  test("creates the account and returns a session with the username", async () => {
    const session = await client.signUpWithUsername("sara", PASSWORD);
    expect(session.userId).toBeString();
    expect(session.isAnonymous).toBe(false);
    expect(session.username).toBe("sara");
    expect(session.accessToken.length).toBeGreaterThan(10);
  });

  test("the wire identifier is the deterministic .invalid alias — never an email the user gave", async () => {
    await client.signUpWithUsername("sara", PASSWORD);
    const alias = await usernameToAuthIdentifier("sara");
    const signups = mock.callsTo("/auth/v1/signup");
    expect(signups.length).toBe(1);
    expect(signups[0].email).toBe(alias);
    expect(alias.endsWith("@echo.invalid")).toBe(true);
  });

  test("duplicate username (any case) → username_taken", async () => {
    await client.signUpWithUsername("sara", PASSWORD);
    for (const variant of ["sara", "SARA", "  Sara "]) {
      let err: unknown = null;
      try {
        await client.signUpWithUsername(variant, "another-pass-123");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AuthFlowError);
      expect((err as AuthFlowError).code).toBe("username_taken");
    }
    // still exactly ONE account for the canonical name
    expect(mock.users.filter((u) => u.isAnonymous === false).length).toBe(1);
  });

  test("policy failures reject before any network call", async () => {
    for (const bad of ["ab", "has space", "admin", "x".repeat(33)]) {
      await expect(client.signUpWithUsername(bad, PASSWORD)).rejects.toMatchObject({
        code: "invalid_username",
      });
    }
    await expect(client.signUpWithUsername("goodname", "short")).rejects.toMatchObject({
      code: "weak_password",
    });
    expect(mock.calls.length).toBe(0);
  });
});

describe("sign-in with username + password", () => {
  test("round-trip: sign out → sign in → same user id and username", async () => {
    const created = await client.signUpWithUsername("omar", PASSWORD);
    await client.signOut();
    expect(await client.getSession()).toBeNull();
    const signedIn = await client.signInWithUsername("omar", PASSWORD);
    expect(signedIn.userId).toBe(created.userId);
    expect(signedIn.username).toBe("omar");
    expect(signedIn.isAnonymous).toBe(false);
  });

  test("wrong password → GENERIC invalid_credentials (no existence disclosure)", async () => {
    await client.signUpWithUsername("omar", PASSWORD);
    await client.signOut();
    await expect(client.signInWithUsername("omar", "wrong-password-1")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  });

  test("unknown username → the SAME generic error as a wrong password", async () => {
    await client.signUpWithUsername("omar", PASSWORD);
    await client.signOut();
    let unknownErr: AuthFlowError | null = null;
    let wrongErr: AuthFlowError | null = null;
    try {
      await client.signInWithUsername("does_not_exist", PASSWORD);
    } catch (e) {
      unknownErr = e as AuthFlowError;
    }
    try {
      await client.signInWithUsername("omar", "wrong-password-1");
    } catch (e) {
      wrongErr = e as AuthFlowError;
    }
    expect(unknownErr?.code).toBe("invalid_credentials");
    expect(wrongErr?.code).toBe("invalid_credentials");
    expect(unknownErr?.code).toBe(wrongErr?.code); // indistinguishable
  });

  test("case-insensitive sign-in: SARA == sara", async () => {
    const created = await client.signUpWithUsername("sara", PASSWORD);
    await client.signOut();
    const signedIn = await client.signInWithUsername("SARA", PASSWORD);
    expect(signedIn.userId).toBe(created.userId);
  });
});

describe("session persistence (supabase-js localStorage)", () => {
  test("getSession returns the stored session without a new sign-in", async () => {
    await client.signUpWithUsername("layla", PASSWORD);
    const session = await client.getSession();
    expect(session).not.toBeNull();
    expect(session?.username).toBe("layla");
  });
});

describe("anonymous bridge + in-place conversion", () => {
  test("anonymous session converts to a permanent account with the SAME user id", async () => {
    const anon = await client.signInAnonymously();
    expect(anon.isAnonymous).toBe(true);
    expect(anon.username).toBeNull();

    const permanent = await client.convertAnonymousToAccount("mona", PASSWORD);
    expect(permanent.userId).toBe(anon.userId); // ownership preserved
    expect(permanent.isAnonymous).toBe(false);
    expect(permanent.username).toBe("mona");
    // exactly one user in the mock — converted, not duplicated
    expect(mock.users.length).toBe(1);
  });

  test("conversion to a taken username fails and leaves the anonymous session intact", async () => {
    await client.signUpWithUsername("mona", PASSWORD); // account 1
    const other = new SupabaseAuthClient({ url: baseUrl, anonKey: "mock-anon-key" });
    const anon = await other.signInAnonymously(); // account 2 (anonymous)
    await expect(other.convertAnonymousToAccount("MONA", PASSWORD)).rejects.toMatchObject({
      code: "username_taken",
    });
    const still = await other.getSession();
    expect(still?.userId).toBe(anon.userId);
    expect(still?.isAnonymous).toBe(true);
  });
});

describe("password change (session re-authentication — NOT recovery)", () => {
  test("wrong current password is rejected; the account keeps working with the old one", async () => {
    await client.signUpWithUsername("nour", PASSWORD);
    await expect(client.changePassword("not-the-password", "new-password-9")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await client.signOut();
    const again = await client.signInWithUsername("nour", PASSWORD); // old still valid
    expect(again.username).toBe("nour");
  });

  test("correct current password → the new password works on the next sign-in", async () => {
    await client.signUpWithUsername("nour", PASSWORD);
    await client.changePassword(PASSWORD, "brand-new-pass-7");
    await client.signOut();
    await expect(client.signInWithUsername("nour", PASSWORD)).rejects.toBeInstanceOf(AuthFlowError);
    const ok = await client.signInWithUsername("nour", "brand-new-pass-7");
    expect(ok.userId).toBeString();
  });

  test("weak next password is rejected client-side", async () => {
    await client.signUpWithUsername("nour", PASSWORD);
    await expect(client.changePassword(PASSWORD, "short")).rejects.toMatchObject({
      code: "weak_password",
    });
  });
});

describe("the no-recovery / no-mail boundary", () => {
  test("no recovery, OTP, magic-link, resend, verify or invite endpoint is ever called", async () => {
    await client.signUpWithUsername("hana", PASSWORD);
    await client.signOut();
    await client.signInWithUsername("hana", PASSWORD);
    await client.signInAnonymously();
    await client.getSession();
    const outOfScope = mock.outOfScopeCalls();
    expect(outOfScope).toEqual([]);
    for (const banned of ["/auth/v1/recover", "/auth/v1/otp", "/auth/v1/magiclink", "/auth/v1/resend", "/auth/v1/verify"]) {
      expect(mock.callsTo(banned).length).toBe(0);
    }
  });

  test("every wire identifier is an echo.invalid alias — no real-looking email ever sent", async () => {
    await client.signUpWithUsername("zarek", PASSWORD);
    const signups = mock.callsTo("/auth/v1/signup");
    expect(signups.every((c) => c.email === null || c.email.endsWith("@echo.invalid"))).toBe(true);
  });
});
