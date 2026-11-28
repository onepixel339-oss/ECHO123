/**
 * ECHO — local GoTrue-compatible auth server for integration tests.
 *
 * A faithful in-process implementation of the exact Supabase Auth (GoTrue)
 * REST surface ECHO's username adapter relies on, driven through Bun.serve
 * so the REAL `@supabase/supabase-js` client can be exercised end-to-end:
 *
 *   POST /auth/v1/signup                      (signUp, signInAnonymously)
 *   POST /auth/v1/token?grant_type=password   (signInWithPassword)
 *   GET  /auth/v1/user                        (session user)
 *   PUT  /auth/v1/user                        (updateUser)
 *   POST /auth/v1/logout                      (signOut)
 *
 * Behaviors mirrored from the documented GoTrue contract (the exact
 * response SHAPES supabase-js v2 parses, and the exact error strings it
 * surfaces):
 *   - autoconfirm ON ("Confirm email" disabled): signup returns a session
 *     immediately; email identifiers are set directly with no verification
 *     and no outbound mail (this mock has no mail transport at all).
 *   - duplicate signup → 422 {"code":422,"msg":"User already registered",
 *     "error_code":"user_already_exists"} (supabase-js message:
 *     "User already registered").
 *   - bad credentials → 400 {"error":"invalid_grant","error_description":
 *     "Invalid login credentials"} — the GENERIC GoTrue failure that does
 *     not disclose whether the identifier exists.
 *   - anonymous signup (no email/password) → is_anonymous user; a later
 *     PUT /user with email+password converts the SAME user in place.
 *
 * What this mock deliberately is NOT: it is not a hosted Supabase Auth
 * instance. The adapter's hosted verification (real GoTrue binary, hosted
 * Auth configuration) is tracked as a separate owner checkpoint in the
 * handoff; these tests verify everything up to that boundary.
 *
 * The server records every request path it serves (and rejects unknown
 * paths with 404) so tests can assert that NO recovery/mail endpoint
 * (/recover, /otp, /magiclink, /resend, /verify, /invite) is ever called.
 */

export interface MockGoTrueUser {
  id: string;
  email: string | null;
  password: string | null; // the mock's stand-in for GoTrue's bcrypt store
  isAnonymous: boolean;
  userMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface MockGoTrueCall {
  method: string;
  path: string; // path without query, e.g. /auth/v1/signup
  email: string | null; // request body email when present
}

export class GoTrueMock {
  users: MockGoTrueUser[] = [];
  calls: MockGoTrueCall[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private idCounter = 0;
  private tokenToUser = new Map<string, string>();

  /** Starts the server; returns its base URL. */
  async start(): Promise<string> {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => this.route(req),
    });
    return `http://localhost:${this.server.port}`;
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.server = null;
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email : null;
    this.calls.push({ method: req.method, path, email });

    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });

    // ---- POST /auth/v1/signup ----
    if (req.method === "POST" && path === "/auth/v1/signup") {
      const password = typeof body.password === "string" ? body.password : null;
      const hasEmail = typeof body.email === "string" && body.email.length > 0;
      // anonymous sign-in: signup with no email AND no password
      if (!hasEmail && !password) {
        return json(200, this.sessionPayload(this.createUser(null, null, body.data)));
      }
      if (hasEmail && password) {
        if (this.users.some((u) => u.email === body.email)) {
          return json(422, {
            code: 422,
            msg: "User already registered",
            error_code: "user_already_exists",
          });
        }
        const user = this.createUser(body.email as string, password, body.data);
        user.isAnonymous = false;
        return json(200, this.sessionPayload(user));
      }
      return json(400, { msg: "Signup requires a password" });
    }

    // ---- POST /auth/v1/token?grant_type=password ----
    if (req.method === "POST" && path === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") !== "password") {
        return json(400, { error: "unsupported_grant_type" });
      }
      const user = this.users.find((u) => u.email === body.email && u.password === body.password);
      if (!user) {
        // the exact generic GoTrue failure — no user-existence disclosure
        return json(400, {
          error: "invalid_grant",
          error_description: "Invalid login credentials",
        });
      }
      return json(200, this.tokenPayload(user));
    }

    // ---- authenticated endpoints ----
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const userId = this.tokenToUser.get(bearer);
    const user = userId ? this.users.find((u) => u.id === userId) : undefined;

    if (req.method === "GET" && path === "/auth/v1/user") {
      if (!user) return json(401, { message: "Invalid token" });
      return json(200, this.userPayload(user));
    }

    if (req.method === "PUT" && path === "/auth/v1/user") {
      if (!user) return json(401, { message: "Invalid token" });
      if (typeof body.email === "string") {
        // autoconfirm path (Confirm email + Confirm email change disabled):
        // the identifier is set directly; no verification, no mail
        if (this.users.some((u) => u.id !== user.id && u.email === body.email)) {
          return json(422, {
            code: 422,
            msg: "A user with this email address has already been registered",
            error_code: "email_exists",
          });
        }
        user.email = body.email;
      }
      if (typeof body.password === "string" && body.password.length > 0) {
        user.password = body.password;
        user.isAnonymous = false; // password ⇒ permanent account, same id
      }
      if (body.data && typeof body.data === "object") {
        user.userMetadata = { ...user.userMetadata, ...(body.data as Record<string, unknown>) };
      }
      return json(200, this.userPayload(user));
    }

    if (req.method === "POST" && path === "/auth/v1/logout") {
      if (!user) return json(401, { message: "Invalid token" });
      this.tokenToUser.delete(bearer);
      return new Response(null, { status: 204 });
    }

    // anything else (recover, otp, magiclink, resend, verify, invite, admin)
    // is OUT OF SCOPE for ECHO's auth surface — recorded then rejected.
    return json(404, { message: "Not found" });
  }

  private createUser(
    email: string | null,
    password: string | null,
    data: unknown,
  ): MockGoTrueUser {
    this.idCounter += 1;
    const user: MockGoTrueUser = {
      id: `mock-user-${String(this.idCounter).padStart(8, "0")}`,
      email,
      password,
      isAnonymous: email === null && password === null,
      userMetadata: (data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : {}),
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    return user;
  }

  /** base64url JWT-shaped token (the client never verifies the signature). */
  private mintToken(user: MockGoTrueUser): string {
    const enc = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = enc({ alg: "none", typ: "JWT" });
    const payload = enc({
      sub: user.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: "authenticated",
    });
    return `${header}.${payload}.mock`;
  }

  private sessionPayload(user: MockGoTrueUser): Record<string, unknown> {
    const token = this.mintToken(user);
    this.tokenToUser.set(token, user.id);
    return {
      access_token: token,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `mock-refresh-${user.id}`,
      user: this.userPayload(user),
    };
  }

  private tokenPayload(user: MockGoTrueUser): Record<string, unknown> {
    return this.sessionPayload(user);
  }

  private userPayload(user: MockGoTrueUser): Record<string, unknown> {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      is_anonymous: user.isAnonymous,
      created_at: user.createdAt,
      user_metadata: user.userMetadata,
      app_metadata: { provider: "email", providers: ["email"] },
    };
  }

  // ---- test introspection helpers ----

  callsTo(path: string): MockGoTrueCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  outOfScopeCalls(): MockGoTrueCall[] {
    const allowed = new Set([
      "/auth/v1/signup",
      "/auth/v1/token",
      "/auth/v1/user",
      "/auth/v1/logout",
    ]);
    return this.calls.filter((c) => !allowed.has(c.path));
  }
}
