# ECHO — A3 Real-User Validation Kit (README)

**Status:** prepared, **awaiting real cohort results** — A3 is NOT complete until actual participant results are entered and summarized.
**Owner action required:** recruit/coordinate 6–10 real participants (bilingual mix, ≥3 Arabic-first) and return the completed sheets.

## Honesty statement (binding)

Participants and findings must be **real**. Nothing in this kit may be pre-filled, simulated, or extrapolated. If a participant drops out, record the drop-out. If a task fails for everyone, record that. Fabricated user research is a worse outcome than no research — the whole point of A3 is to gate feature work (A4) on evidence.

## What is in this kit

| File | For | Purpose |
|---|---|---|
| `01_INVITATION.md` | owner → participants | Short bilingual invitation text |
| `02_PARTICIPANT_INSTRUCTIONS.md` | participants | What the session is, how long, what to bring |
| `03_PRIVACY_NOTICE.md` | participants | Consent + privacy notice (read before starting) |
| `04_TASK_SCRIPT.md` | facilitator (+ participant tasks) | 9 scripted realistic tasks, incl. the pre-registered progress-attempt task and the AniList local-only badge task |
| `05_FEEDBACK_FORM.md` | participants | Structured feedback + the feature-priority question |
| `06_RETENTION_PULSE.md` | participants (1 week later) | Return-use pulse — only necessary, consented questions |
| `07_OBSERVATION_SHEET.md` | facilitator | Per-participant observation record |
| `08_RESULTS_TEMPLATE.md` | facilitator | Aggregation template + A4 gate computation |
| `A4_GATE.md` | record | The pre-registered A4 decision criteria (do not edit after cohort start) |

## How to run (facilitator checklist)

1. Recruit 6–10 participants; at least 3 should be Arabic-first users.
2. Book a 45–60 minute session per participant (in person or video call with screen share).
3. Prepare a device/browser profile with a **fresh** ECHO instance (no existing library).
4. Give the participant `02_PARTICIPANT_INSTRUCTIONS.md` and `03_PRIVACY_NOTICE.md`; get explicit consent before observing.
5. Run the tasks in `04_TASK_SCRIPT.md` in order. **Do not coach.** Note verbatim quotes for friction.
6. Participant fills `05_FEEDBACK_FORM.md` (or facilitator reads the questions aloud and records answers).
7. One week later, send `06_RETENTION_PULSE.md`.
8. Enter everything in `07_OBSERVATION_SHEET.md` per participant; aggregate in `08_RESULTS_TEMPLATE.md`.
9. Compute the A4 gate exactly as written in `A4_GATE.md` and record the decision.

## Environment notes

- Any modern browser; a fresh profile (or a private window) per participant.
- For task 9 (offline), the facilitator disconnects the network (or uses the browser's offline emulation) — the app must stay usable.
- No accounts, no keys, no installation needed — ECHO runs fully in the browser.
