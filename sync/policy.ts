/**
 * ECHO — cloud sync policy: the licensing boundary, client side.
 *
 * v1.3 PATCH1 §7.3.1: AniList cloudSyncPolicy = none — nothing
 * AniList-derived is uploaded, including pointers and user-created fields
 * attached to AniList records. The classifier runs at seed time and push
 * time (client) and again at the route (server); the RPC carries a further
 * DB-level hard floor. Other providers follow their own approved policies
 * (T-5.3: per provider, not global).
 */

/** Four-level per-provider cloud policy (v1.3 PATCH1 §7.3.1 registry encoding). */
export type CloudSyncPolicy = "full" | "reference" | "pointer" | "none";

/**
 * The policy table. `pointer` remains in the vocabulary but is assigned to
 * NO provider — it is the documented post-clarification candidate payload
 * (owner gate D-20). Changing an entry here is a policy decision that must
 * ride the registry + the RPC hard floor together (T-3.11-style parity).
 */
export const CLOUD_SYNC_POLICIES: Record<string, CloudSyncPolicy> = {
  // full: user's own reference + provider-permitted descriptive fields
  wikidata: "full",
  "echo-demo": "full",
  curated: "full",
  manual: "full",
  trakt: "full",
  bnf: "full",
  // reference: identity fields only
  rawg: "reference",
  igdb: "reference",
  openlibrary: "reference",
  tvmaze: "reference",
  // none: local-only (hard boundary pending written provider clarification)
  anilist: "none",
  kitsu: "none",
};

export function cloudSyncPolicyFor(provider: string): CloudSyncPolicy {
  return CLOUD_SYNC_POLICIES[provider] ?? "reference"; // conservative default
}

/** Artwork and session-state keys never stored server-side (no columns exist). */
const NEVER_SYNCED_KEYS = [
  "posterUrl", "backdropUrl", "trailerUrl", "poster", "backdrop", "trailer",
];

/** Tier R identity fields — always synced for permitted providers. */
const IDENTITY_KEYS = [
  "localId", "provider", "providerId", "workId", "externalIds",
  "mediaType", "format", "subtype", "title", "originalTitle", "titleAr",
  "releaseYear", "endYear", "canonicalUrl", "provenance", "providerRef",
  "sourceAttribution", "metadataFetchedAt", "altTitles",
];

/** Tier D engine-input fields — synced for `full` providers only. */
const DESCRIPTIVE_KEYS = [
  "genres", "tags", "creators", "studios", "languages", "countries",
  "episodeCount", "volumeCount", "chapterCount", "issueCount", "issueNumber",
  "publicationStatus", "runtimeMinutes", "contentRating", "publicScore",
  "rating", "cast",
];

/** Expressive text — NOT synced by default (license-conservative, §8.3). */
const EXPRESSIVE_KEYS = ["synopsis", "synopsisAr"];

/**
 * Field-level strip for cross-provider AniList references riding on
 * non-AniList records (§7.3.1 leak-path table): the AniList key is removed
 * from externalIds; the record itself still syncs.
 */
export function stripAniListReferences(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  if (out.externalIds && typeof out.externalIds === "object") {
    const ext = { ...(out.externalIds as Record<string, unknown>) };
    let changed = false;
    for (const key of Object.keys(ext)) {
      if (key.toLowerCase().includes("anilist")) {
        delete ext[key];
        changed = true;
      }
    }
    if (changed) out.externalIds = ext;
  }
  if (out.provenance && typeof out.provenance === "object") {
    const prov = { ...(out.provenance as Record<string, unknown>) };
    let changed = false;
    for (const key of Object.keys(prov)) {
      if (String(prov[key]).toLowerCase() === "anilist") {
        delete prov[key];
        changed = true;
      }
    }
    if (changed) out.provenance = prov;
  }
  return out;
}

/**
 * Classify a media record for cloud sync. Returns null when the record must
 * not sync AT ALL (AniList-derived under `none`); otherwise returns the
 * payload the server may see: identity fields for every permitted provider,
 * descriptive fields only for `full` providers, artwork/expressive keys
 * never. AniList references riding on other records are stripped.
 */
export function classifyMediaRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const provider = String(record.provider ?? "");
  const policy = cloudSyncPolicyFor(provider);
  if (policy === "none") return null; // AniList / kitsu: local-only, hard boundary

  const allowed = new Set<string>([
    ...IDENTITY_KEYS,
    ...(policy === "full" ? DESCRIPTIVE_KEYS : []),
  ]);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (NEVER_SYNCED_KEYS.includes(key) || EXPRESSIVE_KEYS.includes(key)) continue;
    if (allowed.has(key)) out[key] = record[key];
  }
  return stripAniListReferences(out);
}

/**
 * Entries / feedback / settings are user data (full sync) — but an entry
 * attached to an AniList-derived media record is provider-derived
 * association and stays local (§6.3.6 / T-5.2(e)).
 */
export function entrySyncable(
  entry: Record<string, unknown>,
  mediaProviderById: (mediaLocalId: string) => string | undefined,
): boolean {
  const provider = mediaProviderById(String(entry.mediaLocalId ?? ""));
  if (provider === undefined) return true; // unknown media — let the server's rules speak
  return cloudSyncPolicyFor(provider) !== "none";
}

/** Works / work_links: strip AniList-bearing reference fields (§7.3.1). */
export function classifyWorkRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const text = JSON.stringify(record);
  if (/"anilist"/i.test(text)) {
    return stripAniListReferences(record);
  }
  return record;
}
