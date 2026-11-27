# ECHO — Username + Password Auth (Supabase) — Setup & Verification

**Status:** the adapter is implemented and fully tested locally against a
faithful GoTrue-compatible server driving the real supabase-js client
(32 tests: signup, case-insensitive duplicates, generic sign-in failures,
session persistence, anonymous bridge, in-place conversion, password
change, and a hard "no recovery endpoint is ever called" assertion). The
hosted-verification steps below are the owner's Actions 5–6 — the only
parts a local test cannot cover.

## The design in one paragraph

Supabase Auth (GoTrue) does not expose a native username sign-in — its
password identity is bound to an email or phone identifier. ECHO keeps the
product contract (username + password only, no email ever requested) by
deriving a deterministic, opaque **internal alias** for each username:

```
alias = "echo-u-" + first 32 hex chars of SHA-256("echo-username-v1:" + canonical-username) + "@echo.invalid"
```

`.invalid` is reserved by RFC 2606 for names that are sure to be invalid —
no mail can ever be delivered to it. The alias is deterministic (same
username → same alias on every device, forever), case-insensitive (the
username is NFC-normalized and case-folded first — "Sara" and "sara" are
ONE account), opaque (a SHA-256 prefix leaks nothing about the name and
cannot be reversed), and collision-safe (a 128-bit prefix; the birthday
bound at four billion accounts is 2⁻⁶⁴). ECHO never displays it, never asks
the user to remember it, and never treats it as a verified email. Passwords
are handled exclusively by Supabase Auth (bcrypt in GoTrue) — ECHO stores
no password, no password-derived value, and no password hint anywhere.

## Required Supabase Auth configuration

| Setting | Value | Why |
|---|---|---|
| Email provider | **ON** | The password identity carrier (via the internal alias) |
| Confirm email | **OFF** | No mailbox exists; users must be created directly |
| Confirm change of email | **OFF** | Same — the alias updates directly |
| Google / GitHub / Phone / SAML / Magic link | **OFF** | Username + password only |
| Anonymous sign-ins | **ON** | The local-first bridge (convert to permanent later) |
| Rate limiting / captcha | Leave Supabase's defaults ON | Abuse protection is Supabase's, ECHO adds generic errors on top |

Note: with "Confirm email" disabled, Supabase's documented behavior is to
treat the identifier as not needing verification and implicitly confirm it
— **this is acceptable ONLY because the identifier is a non-deliverable
`.invalid` alias, never a real user address.** ECHO never claims the user
verified an email.

## What ECHO enforces on top

- Username policy: 3–32 chars, `a-z 0-9 _` after canonicalization, reserved
  names rejected (`admin`, `echo`, `support`, …), uniqueness via the alias
  (case-insensitive).
- Password policy: 8–128 characters (deliberately stricter than Supabase's
  default 6 minimum).
- Sign-in errors are ALWAYS generic ("Wrong username or password.") — no
  user-existence disclosure; only sign-UP may say the name is taken.
- No password reset, recovery, magic link, or "forgot password" UI exists
  anywhere; no recovery endpoint is ever called (test-asserted).
- The pre-signup warning (EN/AR) states the irreversible loss plainly and
  requires an explicit acknowledgement checkbox before the account is
  created. Password change requires the current password
  (re-authentication, not recovery).

## Hosted verification (Owner Action 6)

Do these on the real project after Actions 3–5:

1. Create `testuser1` with a throwaway strong password in the app.
   - [ ] Account created instantly; NO "check your email" screen.
   - [ ] Supabase → Authentication → Users shows the user with an
         `echo-u-…@echo.invalid` identifier and **Email confirmed = true**
         with no mail in any queue (Mail section shows zero messages).
2. Try to create `TESTUSER1` again.
   - [ ] The app says "This username is already taken."
3. Sign in with a wrong password.
   - [ ] The app shows the generic "Wrong username or password."
4. Sign in correctly, open Settings → Account & sync.
   - [ ] "Signed in as testuser1", Devices lists this device, the three
         bootstrap choices appear, sync works after choosing.
5. Anonymous bridge: sign out → "Start sync without an account" → "Make it
   permanent" with a new username.
   - [ ] The SAME user row in Supabase (no duplicate), now non-anonymous.
6. Password change: wrong current password is rejected; correct one works.
7. Check Authentication → Users → the test user → "Danger zone" has no
   path that ECHO exposes (account deletion is the app's own flow).

## Fallback (only if the hosted Auth service rejects the alias pattern)

If signup on the hosted project fails, attempts to send mail, or cannot be
made robust against enumeration, **the adapter must not ship**. The
documented fallbacks, in order of preference:

1. **Disable accounts/sync** (the app remains fully functional locally —
   this is the designed posture anyway) and report the exact error to the
   agent for a re-scoped auth design.
2. A separately reviewed maintained auth provider with native username
   support (a product decision + security review — not a quick patch).
3. Under NO circumstances: silently switching users to real email sign-in,
   weakening RLS/rate limits, or storing passwords in ECHO-owned tables.

## Where the code lives

- `lib/echo/sync/usernameAuth.ts` — canonicalization, policies, alias, error map
- `lib/echo/sync/auth.ts` — the supabase-js wrapper (signup / sign-in /
  anonymous / convert / change-password / sign-out)
- `lib/echo/__tests__/auth/` — the local GoTrue-compatible server + 32 tests
- `components/echo/sync/SyncSettings.tsx` — the bilingual account UI with
  the irreversible-loss warning + acknowledgement
