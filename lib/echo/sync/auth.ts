/**
 * ECHO — B1 authentication client (1.3.0: username + password ONLY).
 *
 * Owner decision 2026-11-27: the only permanent account method is
 * username + password. No email address, no phone number, no Google, no
 * GitHub, no social sign-in, no magic links, no SMTP — and deliberately NO
 * password reset/recovery in this release (the UI states the irreversible
 * loss warning before signup and requires an explicit acknowledgement).
 *
 * Supabase Auth owns password hashing and verification; ECHO never stores
 * passwords, password-derived values, or password hints in its own tables,
 * IndexedDB (beyond what supabase-js persists as the session), localStorage,
 * logs, analytics, crash reports, or exports.
 *
 * Anonymous/local use remains a complete supported mode: the app is fully
 * functional without an account. Opting into sync can start anonymously and
 * be converted to a permanent username account in place (the same user id —
 * local data ownership is preserved; no re-linking of records is needed).
 *
 * The username→identifier adapter (usernameAuth.ts) maps the username onto
 * a deterministic internal `.invalid` alias so Supabase's password identity
 * can carry it WITHOUT the user ever seeing or providing an email. See that
 * module's header for the full compatibility rationale and the required
 * hosted Auth configuration.
 */

import {
  canonicalizeUsername,
  usernameToAuthIdentifier,
  validateUsernamePolicy,
  validatePasswordPolicy,
  mapAuthError,
  type AuthErrorCode,
} from "./usernameAuth";

export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

/** Reads the placeholder-only public config; null when sync is not configured. */
export function readSupabaseConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url, anonKey };
}

export function isSyncConfigured(): boolean {
  return readSupabaseConfig() !== null;
}

export interface AuthSession {
  userId: string;
  isAnonymous: boolean;
  /** the account's display username, when the session carries one */
  username: string | null;
  accessToken: string;
}

export class AuthFlowError extends Error {
  constructor(public code: AuthErrorCode) {
    super(code);
  }
}

/**
 * Thin wrapper over the supabase-js client, loaded lazily so the (optional)
 * dependency never touches the local-only experience. The wrapper is the
 * ONLY place that knows about the client library: the (hosted-only)
 * integration surface stays replaceable and the local app never imports it
 * unless sync is configured.
 */
export interface AuthClientPort {
  /** Create a permanent account (username + password). No email is ever requested. */
  signUpWithUsername(username: string, password: string): Promise<AuthSession>;
  /** Sign in with username + password. ALL failures are generic. */
  signInWithUsername(username: string, password: string): Promise<AuthSession>;
  /** Start (or continue) as an anonymous/local cloud user — full user, ephemeral account. */
  signInAnonymously(): Promise<AuthSession>;
  /**
   * Convert the CURRENT anonymous session into a permanent username account
   * in place (same user id — data ownership is preserved). Requires an
   * active anonymous session.
   */
  convertAnonymousToAccount(username: string, password: string): Promise<AuthSession>;
  /** Change the password of the signed-in account after re-verifying the current one. */
  changePassword(currentPassword: string, nextPassword: string): Promise<void>;
  signOut(): Promise<void>;
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(cb: (session: AuthSession | null) => void): () => void;
}

/** Extracts the username the account was created with (stored as app metadata). */
const USERNAME_META_KEY = "echo_username";

function sessionFrom(supabaseSession: {
  user: { id: string; is_anonymous: boolean; user_metadata?: Record<string, unknown> };
  access_token: string;
}): AuthSession {
  return {
    userId: supabaseSession.user.id,
    isAnonymous: supabaseSession.user.is_anonymous === true,
    username:
      typeof supabaseSession.user.user_metadata?.[USERNAME_META_KEY] === "string"
        ? (supabaseSession.user.user_metadata[USERNAME_META_KEY] as string)
        : null,
    accessToken: supabaseSession.access_token,
  };
}

export class SupabaseAuthClient implements AuthClientPort {
  private client: {
    auth: {
      signUp(o: {
        email: string;
        password: string;
        options: { data: Record<string, unknown> };
      }): Promise<{
        data: { user: { id: string; is_anonymous?: boolean } | null; session: { access_token: string; user: { id: string; is_anonymous: boolean; user_metadata?: Record<string, unknown> } } | null };
        error: null | { message: string };
      }>;
      signInWithPassword(o: {
        email: string;
        password: string;
      }): Promise<{
        data: { user: { id: string; is_anonymous?: boolean; user_metadata?: Record<string, unknown> }; session: { access_token: string; user: { id: string; is_anonymous: boolean; user_metadata?: Record<string, unknown> }; } | null };
        error: null | { message: string };
      }>;
      signInAnonymously(): Promise<{ data: { user: { id: string }; session: { access_token: string; user: { id: string; is_anonymous: boolean; user_metadata?: Record<string, unknown> } } | null }; error: null | { message: string } }>;
      updateUser(o: {
        email?: string;
        password?: string;
        data?: Record<string, unknown>;
      }): Promise<{
        data: { user: { id: string; is_anonymous?: boolean; user_metadata?: Record<string, unknown> } };
        error: null | { message: string };
      }>;
      signOut(): Promise<{ error: null | { message: string } }>;
      getSession(): Promise<{ data: { session: {
        user: { id: string; is_anonymous: boolean; user_metadata?: Record<string, unknown> }; access_token: string;
      } | null } }>;
      onAuthStateChange(cb: (event: string, session: unknown) => void): { data: { subscription: { unsubscribe(): void } } };
    };
  } | null = null;

  constructor(private config: SupabasePublicConfig) {}

  private async getClient(): Promise<NonNullable<SupabaseAuthClient["client"]>> {
    if (this.client) return this.client;
    const { createClient } = await import("@supabase/supabase-js");
    this.client = createClient(this.config.url, this.config.anonKey, {
      auth: {
        persistSession: true,      // client-managed session (v1.1 §7.2)
        autoRefreshToken: true,
        detectSessionInUrl: false, // no OAuth redirect to complete anymore
      },
    }) as unknown as NonNullable<SupabaseAuthClient["client"]>;
    return this.client;
  }

  async signUpWithUsername(username: string, password: string): Promise<AuthSession> {
    const u = validateUsernamePolicy(username);
    if (!u.ok) throw new AuthFlowError("invalid_username");
    if (!validatePasswordPolicy(password)) throw new AuthFlowError("weak_password");
    const client = await this.getClient();
    const identifier = await usernameToAuthIdentifier(u.canonical);
    const { data, error } = await client.auth.signUp({
      email: identifier, // internal .invalid alias — never shown to the user
      password,
      options: { data: { [USERNAME_META_KEY]: u.canonical } },
    });
    if (error) {
      throw new AuthFlowError(mapErr(error.message, "signup"));
    }
    if (!data.session) {
      // With "Confirm email" disabled a session is returned immediately.
      // No session here means the hosted project still has confirmations
      // ON (misconfiguration) — fail closed with an honest error rather
      // than pretending the account exists.
      throw new AuthFlowError("unknown");
    }
    return sessionFrom(data.session);
  }

  async signInWithUsername(username: string, password: string): Promise<AuthSession> {
    const canonical = canonicalizeUsername(username);
    const client = await this.getClient();
    const identifier = await usernameToAuthIdentifier(canonical);
    const { data, error } = await client.auth.signInWithPassword({
      email: identifier,
      password,
    });
    if (error) {
      // ALWAYS generic — never disclose whether the username exists
      throw new AuthFlowError(mapErr(error.message, "signin"));
    }
    if (!data.session) throw new AuthFlowError("invalid_credentials");
    return sessionFrom(data.session);
  }

  async signInAnonymously(): Promise<AuthSession> {
    const client = await this.getClient();
    const { data, error } = await client.auth.signInAnonymously();
    if (error) throw new AuthFlowError(mapErr(error.message, "update"));
    if (!data.session) throw new AuthFlowError("unknown");
    return sessionFrom(data.session);
  }

  async convertAnonymousToAccount(username: string, password: string): Promise<AuthSession> {
    const u = validateUsernamePolicy(username);
    if (!u.ok) throw new AuthFlowError("invalid_username");
    if (!validatePasswordPolicy(password)) throw new AuthFlowError("weak_password");
    const client = await this.getClient();
    const current = await client.auth.getSession();
    if (!current.data.session || current.data.session.user.is_anonymous !== true) {
      throw new AuthFlowError("unknown"); // no anonymous session to convert
    }
    const identifier = await usernameToAuthIdentifier(u.canonical);
    // updateUser on the anonymous user converts it in place: same user id,
    // password set by Supabase Auth, identifier set to the internal alias.
    // With "Confirm email" disabled no confirmation flow is triggered.
    const { error } = await client.auth.updateUser({
      email: identifier,
      password,
      data: { [USERNAME_META_KEY]: u.canonical },
    });
    if (error) throw new AuthFlowError(mapErr(error.message, "update"));
    const refreshed = await client.auth.getSession();
    if (!refreshed.data.session) throw new AuthFlowError("unknown");
    return sessionFrom(refreshed.data.session);
  }

  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    if (!validatePasswordPolicy(nextPassword)) throw new AuthFlowError("weak_password");
    const client = await this.getClient();
    const current = await client.auth.getSession();
    if (!current.data.session) throw new AuthFlowError("invalid_credentials");
    // Re-verify the current password BEFORE accepting the change — this is
    // session re-authentication, not password recovery.
    const username = current.data.session.user.user_metadata?.[USERNAME_META_KEY];
    const identifier = typeof username === "string"
      ? await usernameToAuthIdentifier(username)
      : null;
    const verify = identifier
      ? await client.auth.signInWithPassword({
          email: identifier,
          password: currentPassword,
        })
      : null;
    if (!verify || verify.error || !verify.data.session) {
      throw new AuthFlowError("invalid_credentials");
    }
    if (verify.data.session.user.id !== current.data.session.user.id) {
      throw new AuthFlowError("invalid_credentials");
    }
    const { error } = await client.auth.updateUser({ password: nextPassword });
    if (error) throw new AuthFlowError(mapErr(error.message, "update"));
  }

  async signOut(): Promise<void> {
    const client = await this.getClient();
    await client.auth.signOut();
  }

  async getSession(): Promise<AuthSession | null> {
    const client = await this.getClient();
    const { data } = await client.auth.getSession();
    if (!data.session) return null;
    return sessionFrom(data.session);
  }

  onAuthStateChange(cb: (session: AuthSession | null) => void): () => void {
    let unsub: (() => void) | null = null;
    void this.getClient().then((client) => {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (!session) return cb(null);
        cb(sessionFrom(session as Parameters<typeof sessionFrom>[0]));
      });
      unsub = () => data.subscription.unsubscribe();
    });
    return () => unsub?.();
  }
}

function mapErr(message: string, phase: "signin" | "signup" | "update"): AuthErrorCode {
  return mapAuthError(message, phase);
}
