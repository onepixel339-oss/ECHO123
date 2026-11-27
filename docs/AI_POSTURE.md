# ECHO — AI posture (decision record)

**Current state (v1.3.0, 2026-11-28): ECHO ships with NO generative AI.**

## The 1.3.0 owner decision

On 2026-11-27 the owner decided:

1. **Gemini is removed from the product.** ECHO does not require a Gemini
   key, does not call Gemini (or any other LLM), and does not claim that
   Gemini/AI powers any feature. All Gemini SDK usage, API routes, model
   names, prompts, model configuration, environment variables
   (`GEMINI_API_KEY`, `GEMINI_MODEL`), and fallback claims are deleted.
2. **The "Ask ECHO" conversational assistant is removed from the initial
   release.** It is not replaced with canned responses presented as
   conversational AI — no fake chatbot ships.
3. The Taste Companion and the weekly library digest (the other two
   LLM-backed features) were removed with it: they existed only on top of
   the deleted LLM provider chain.

What remains is the **deterministic, local taste engine** (Taste DNA,
insights with sample counts, recommendations, the taste identity card) —
pure rules and statistics, honestly labelled, with no AI claims anywhere.

## History (superseded posture, kept for the record)

Before 1.3.0 the posture was "off by default, bring-your-own-key": the
three AI features (Ask ECHO, Taste Companion, weekly digest) shipped
disabled and required a deployment-provided Gemini key; without a key they
returned a designed `ai_unavailable` state. That design was clean, but the
owner's 1.3.0 decision removes the features outright for the initial
release. No code path, route, key, or claim from that era remains in the
product.

## Future direction (product note only — NOT implemented)

A possible future feature is a clearly labelled, deterministic
**"Taste Insights" / guided discovery** flow built on ECHO's existing local
taste engine: a small set of guided questions and recommendations derived
locally from ratings, tags, statuses, notes, and the taste profile. It must
be described honestly as rules and analysis — never as AI — and it is
deferred until after release and real-user validation. Nothing in the
current codebase implements or anticipates it beyond this note.

## Verification

- `grep -ri gemini` over the source returns nothing (CI keeps it that way —
  the secret scan and the scope assertions in `scripts/cost-table.ts`
  refuse any tier definition that mentions a retired service).
- No AI-related route exists under `app/api/`.
- No AI key or model variable appears in `.env.example`.
- The cost table documents a $0, AI-free tier model only.
