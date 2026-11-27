# A4 gate — pre-registered decision criteria / بوابة A4 — معايير القرار المسجّلة مسبقاً

> **Frozen before the cohort starts.** Do not edit the criteria after participant data begins arriving (Transformation Master Plan v1.2/v1.3 PATCH1 §9.3; Autonomous Execution Brief §5.3). Only the DECISION RECORD below is filled in afterwards.

## The criteria (pre-registered) / المعايير (مسجّلة مسبقاً)

Progress/episode tracking (A4) is implemented **only if at least one** of these fires:

1. **≥ 40% of cohort participants** *attempt* fine-grained progress recording (episode/volume/chapter position) during the task sessions **and** report friction when they cannot; **or**
2. "Progress/episode tracking" appears in the **top-3 requested features** across the cohort's structured feedback (form C1 tally).

If **neither** fires:
- progress tracking is **recorded as a non-goal for this planning round** (revisitable in a future round with fresh evidence);
- the additive schema-v4 design **stays shelved** (zero rework — it was designed additive precisely for this);
- **D-11 remains downgraded** to "conditional on validation evidence".

If the gate fires: implement **only the additive v4 design** from the plan (`entry.progress { kind: episode|volume|chapter, value, target?, updatedAt }`), with migration/backward-compatibility tests, without disturbing the existing taste engine.

## Current status / الحالة الحالية

**DEFERRED — awaiting real A3 evidence.** No cohort results exist yet (the owner must recruit participants and return the completed kit). Nothing has been implemented; nothing is claimed.

## Decision record (fill after results) / سجل القرار (يُملأ بعد النتائج)

- Date of computation: ______
- Condition 1: ___ % attempted-with-friction (n = ___) → ☐ met ☐ not met
- Condition 2: progress tracking in top-3 for ___ of ___ participants → ☐ met ☐ not met
- **Decision:** ☐ A4 gated IN (implement additive v4) ☐ A4 deferred — non-goal this round
- Computed by: ______ Verified by (owner): ______
