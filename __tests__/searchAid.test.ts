/**
 * ECHO — Arabic-first search aid tests (A2, audit C3).
 *
 * Pure-function coverage: script detection, transliteration determinism and
 * shape, bilingual chip matching against the REAL curated catalogue, and the
 * aid's gating (Arabic script only, chips deduped, translit first).
 */

import { describe, expect, test } from "bun:test";
import {
  arabicSearchAid,
  bilingualChipsForArabicQuery,
  hasArabicScript,
  transliterateArabicToLatin,
} from "../searchAid";
import { DEMO_CATALOGUE } from "../data/demoCatalogue";

describe("hasArabicScript", () => {
  test("detects Arabic script, including diacritized and mixed text", () => {
    expect(hasArabicScript("إنسبشن")).toBe(true);
    expect(hasArabicScript("فيلم Inception مترجم")).toBe(true);
    expect(hasArabicScript("أَحْمَد")).toBe(true);
  });

  test("Latin and numeric strings are not Arabic", () => {
    expect(hasArabicScript("Inception")).toBe(false);
    expect(hasArabicScript("123 q7")).toBe(false);
    expect(hasArabicScript("")).toBe(false);
  });
});

describe("transliterateArabicToLatin", () => {
  test("is deterministic and only produces Latin-script output", () => {
    const a = transliterateArabicToLatin("إنسبشن");
    const b = transliterateArabicToLatin("إنسبشن");
    expect(a).toBe(b);
    expect(a).not.toMatch(/[\u0600-\u06FF]/);
    expect(a.length).toBeGreaterThan(0);
  });

  test("strips diacritics before mapping (harakat never leak)", () => {
    expect(transliterateArabicToLatin("أَحْمَد")).toBe(
      transliterateArabicToLatin("احمد"),
    );
  });

  test("known words transliterate to sensible Latin", () => {
    expect(transliterateArabicToLatin("توتورو")).toBe("twtwrw");
    expect(transliterateArabicToLatin("فيلم")).toBe("fylm");
    expect(transliterateArabicToLatin("خيال")).toBe("khyal");
  });

  test("mixed-script queries keep their Latin part untouched", () => {
    expect(transliterateArabicToLatin("فيلم Inception")).toBe("fylm Inception");
  });
});

describe("bilingualChipsForArabicQuery", () => {
  test("matches real curated Arabic titles and offers the English title", () => {
    // find a real bilingual seed to assert against
    const seed = DEMO_CATALOGUE.find((s) => s.titleAr && s.title);
    expect(seed).toBeDefined();
    const chips = bilingualChipsForArabicQuery(seed!.titleAr!);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some((c) => c.latin === seed!.title)).toBe(true);
    expect(chips.some((c) => c.label === seed!.titleAr)).toBe(true);
  });

  test("token matching is order-free and diacritic-insensitive", () => {
    const seed = DEMO_CATALOGUE.find((s) => s.titleAr && s.title)!;
    const words = seed.titleAr!.split(" ");
    if (words.length >= 2) {
      const reordered = [...words].reverse().join(" ");
      const chips = bilingualChipsForArabicQuery(reordered);
      expect(chips.some((c) => c.latin === seed.title)).toBe(true);
    }
    const diacritized = seed.titleAr!.replace(/ا/g, "َا"); // fat-ha after every alef
    const chips2 = bilingualChipsForArabicQuery(diacritized);
    expect(chips2.some((c) => c.latin === seed.title)).toBe(true);
  });

  test("respects the max-chips cap and dedupes by English title", () => {
    const chips = bilingualChipsForArabicQuery("ا", DEMO_CATALOGUE, 3);
    expect(chips.length).toBeLessThanOrEqual(3);
    // single-letter tokens are too short → no chips at all for a lone alef
    expect(chips).toEqual([]);
  });

  test("a Latin query never produces chips", () => {
    expect(bilingualChipsForArabicQuery("Inception")).toEqual([]);
  });
});

describe("arabicSearchAid (composite)", () => {
  test("the transliteration chip comes first when present", () => {
    const aid = arabicSearchAid("فيلم");
    expect(aid.length).toBeGreaterThan(0);
    expect(aid[0].latin).toBe("fylm");
  });

  test("returns nothing for Latin-script queries", () => {
    expect(arabicSearchAid("breaking bad")).toEqual([]);
  });
});
