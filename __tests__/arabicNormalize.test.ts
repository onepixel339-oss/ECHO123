/**
 * A2 regression tests: Arabic-aware title normalization (dedupe.normalizeTitle).
 *
 * Folding rules under test:
 *  - harakat (diacritics) and tatweel are stripped;
 *  - alef variants (آ أ إ ٱ) unify to plain alef;
 *  - taa marbuta (ة) unifies to ha (ه);
 *  - alef maqsura (ى) unifies to ya (ي);
 *  - non-letter separators collapse (pre-existing behaviour, kept honest).
 *
 * These make Arabic queries match Arabic titles regardless of orthographic
 * variants — the shared basis for search relevance, dedupe and the
 * Arabic-first search aid.
 */

import { describe, expect, test } from "bun:test";
import { normalizeTitle } from "../federated/dedupe";
import { isQidTitle } from "../ids";

describe("normalizeTitle — Arabic folding (A2)", () => {
  test("harakat and tatweel are stripped", () => {
    expect(normalizeTitle("أَحْمَد")).toBe(normalizeTitle("احمد"));
    expect(normalizeTitle("مـدرســة")).toBe(normalizeTitle("مدرسة"));
  });

  test("alef variants unify to plain alef", () => {
    expect(normalizeTitle("آدم")).toBe(normalizeTitle("ادم"));
    expect(normalizeTitle("أحمد")).toBe(normalizeTitle("احمد"));
    expect(normalizeTitle("إيمان")).toBe(normalizeTitle("ايمان"));
  });

  test("taa marbuta and alef maqsura unify", () => {
    expect(normalizeTitle("مدرسة")).toBe(normalizeTitle("مدرسه"));
    expect(normalizeTitle("على")).toBe(normalizeTitle("علي"));
  });

  test("the definite article is NOT stripped (distinct titles stay distinct)", () => {
    expect(normalizeTitle("التاريخ")).not.toBe(normalizeTitle("تاريخ"));
  });

  test("separators and case still collapse for Latin titles", () => {
    expect(normalizeTitle("The Twilight Zone!")).toBe(normalizeTitle("the twilight zone"));
  });

  test("a fully-diacritized real title matches its plain form", () => {
    expect(normalizeTitle("جَارِي تُوتُورُو")).toBe(normalizeTitle("جاري توتورو"));
  });
});

describe("isQidTitle (A2 / H3 / C7)", () => {
  test("raw Q-ids are detected", () => {
    expect(isQidTitle("Q7322")).toBe(true);
    expect(isQidTitle(" Q123456 ")).toBe(true);
  });

  test("real titles and near-misses are not", () => {
    expect(isQidTitle("Citizen Kane")).toBe(false);
    expect(isQidTitle("Q7322: The Movie")).toBe(false);
    expect(isQidTitle("")).toBe(false);
    expect(isQidTitle(undefined)).toBe(false);
    expect(isQidTitle(null)).toBe(false);
    expect(isQidTitle("q7322")).toBe(false); // lowercase is not a Wikidata id
  });
});
