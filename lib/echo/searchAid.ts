/**
 * ECHO — Arabic-first search aid (A2, audit C3: "Arabic queries thin on
 * Latin-script providers").
 *
 * Latin-script catalogues (TVMaze, RAWG, Open Library, Trakt…) cannot answer
 * Arabic-script queries. Rather than silently double-firing every provider
 * (rate limits, noise), ECHO offers an explicit, honest aid when an Arabic
 * query returns few live results:
 *
 *   1. a transliteration chip — the query rewritten in Latin script via a
 *      standard letter map (heuristic by design, clearly labelled);
 *   2. bilingual suggestion chips — titles from ECHO's approved local
 *      catalogue whose ARABIC title matches the query, offered with their
 *      English title for a one-tap re-search.
 *
 * Clicking a chip re-runs the search with the Latin string — the user always
 * stays in control of what is queried.
 */

import { DEMO_CATALOGUE, type DemoSeed } from "./data/demoCatalogue";

/** Does the string contain any Arabic-script letter? */
export function hasArabicScript(q: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(q);
}

/** Strip Arabic diacritics (harakat), superscript alef and tatweel. */
function stripDiacritics(s: string): string {
  return s.replace(/[\u064B-\u065F\u0670\u0640]/g, "");
}

/**
 * Standard Arabic → Latin letter map (heuristic, DIN-31635-ish simplified).
 * Multi-char letters first so ؤ/ئ/ث… map before single-letter prefixes.
 */
const TRANSLIT: Array<[RegExp, string]> = [
  [/آ|أ|إ|ٱ|ا/g, "a"],
  [/ب/g, "b"],
  [/ت/g, "t"],
  [/ث/g, "th"],
  [/ج/g, "j"],
  [/ح/g, "h"],
  [/خ/g, "kh"],
  [/د/g, "d"],
  [/ذ/g, "dh"],
  [/ر/g, "r"],
  [/ز/g, "z"],
  [/س/g, "s"],
  [/ش/g, "sh"],
  [/ص/g, "s"],
  [/ض/g, "d"],
  [/ط/g, "t"],
  [/ظ/g, "z"],
  [/ع/g, "a"],
  [/غ/g, "gh"],
  [/ف/g, "f"],
  [/ق/g, "q"],
  [/ك/g, "k"],
  [/ل/g, "l"],
  [/م/g, "m"],
  [/ن/g, "n"],
  [/ه|ة/g, "h"],
  [/و|ؤ/g, "w"],
  [/ي|ى|ئ/g, "y"],
  [/ء/g, "'"],
  [/\s+/g, " "],
];

/**
 * Transliterate an Arabic-script query into a Latin approximation.
 * Pure function; deterministic; never throws. Non-Arabic characters pass
 * through untouched so mixed queries still work.
 */
export function transliterateArabicToLatin(q: string): string {
  let out = stripDiacritics(q);
  for (const [re, latin] of TRANSLIT) out = out.replace(re, latin);
  return out.replace(/\s+/g, " ").trim();
}

/* ---------------------------- suggestion chips ----------------------------- */

export interface SearchAidChip {
  /** the string to re-search with (Latin script) */
  latin: string;
  /** the chip's display label */
  label: string;
}

/** Normalizer shared with the dedupe layer's Arabic folding rules. */
function foldArabic(s: string): string {
  return stripDiacritics(s)
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064A")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bilingual chips: local-catalogue titles whose ARABIC title matches the
 * Arabic query (token containment, order-free). The chip offers the ENGLISH
 * title — one tap re-searches in the script Latin catalogues understand.
 */
export function bilingualChipsForArabicQuery(
  q: string,
  seeds: DemoSeed[] = DEMO_CATALOGUE,
  max = 4,
): SearchAidChip[] {
  const queryTokens = foldArabic(q).split(" ").filter((t) => t.length >= 2);
  if (!queryTokens.length) return [];
  const chips: SearchAidChip[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (!seed.titleAr || !seed.title) continue;
    const arTokens = foldArabic(seed.titleAr).split(" ").filter(Boolean);
    const matches = queryTokens.every((qt) =>
      arTokens.some((at) => at.includes(qt) || qt.includes(at)),
    );
    if (!matches || seen.has(seed.title)) continue;
    seen.add(seed.title);
    chips.push({ latin: seed.title, label: seed.titleAr });
    if (chips.length >= max) break;
  }
  return chips;
}

/**
 * The full aid for an Arabic query: the transliteration chip (always first,
 * when it differs from the query) plus the bilingual chips.
 */
export function arabicSearchAid(q: string, seeds?: DemoSeed[]): SearchAidChip[] {
  if (!hasArabicScript(q)) return [];
  const out: SearchAidChip[] = [];
  const translit = transliterateArabicToLatin(q);
  if (translit && translit !== q.trim()) out.push({ latin: translit, label: translit });
  out.push(...bilingualChipsForArabicQuery(q, seeds));
  return out;
}
