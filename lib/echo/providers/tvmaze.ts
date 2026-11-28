/**
 * ECHO — TVMaze adapter (series & TV).
 *
 * Real source: TVMaze's free public API (api.tvmaze.com). No key required.
 * Attribution: "Data from TVMaze" with a link to the show's TVMaze page.
 */

import type { MediaItem } from "../types";
import {
  fetchJson,
  normalizeGenre,
  type CatalogueProvider,
  type ProviderSearchResult,
  type SearchFilters,
} from "./types";
import { cached, TTLCache } from "./cache";
import { stampCatalogProvenance } from "./provenance";

interface TvShow {
  id: number;
  url?: string;
  name?: string;
  type?: string;
  language?: string;
  genres?: string[];
  status?: string;
  averageRuntime?: number | null;
  premiered?: string | null;
  ended?: string | null;
  rating?: { average?: number | null };
  image?: { medium?: string; original?: string };
  summary?: string | null;
  network?: { name?: string; country?: { name?: string } } | null;
  webChannel?: { name?: string; country?: { name?: string } } | null;
  externals?: { imdb?: string | null };
  officialSite?: string | null;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search-scope normalizer: lowercase, strip Latin combining marks, keep
 * letters/numbers, collapse the rest to single spaces.
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A2 fix (audit H2 — TVMaze fuzzy noise): keep only hits whose normalized
 * title actually CONTAINS every query token. TVMaze's /search/shows does
 * loose fuzzy matching and happily returns barely-related shows; this
 * post-filter guarantees every returned row mentions what was typed.
 * Exported for tests.
 */
export function tvmazeTitleMatchesQuery(title: string | undefined, query: string): boolean {
  const t = normalizeForMatch(title ?? "");
  if (!t) return false; // untitled rows are noise in a result list
  const tokens = normalizeForMatch(query).split(" ").filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((tok) => t.includes(tok));
}

function toMediaItem(show: TvShow): MediaItem {
  const network = show.network?.name ?? show.webChannel?.name;
  const country = show.network?.country?.name ?? show.webChannel?.country?.name;
  const communityRating = show.rating?.average ?? null;
  return stampCatalogProvenance({
    localId: `tvmaze:${show.id}`,
    provider: "tvmaze",
    providerId: String(show.id),
    canonicalUrl: show.url,
    mediaType: "series",
    format: "series",
    title: show.name ?? "Untitled",
    synopsis: show.summary ? stripHtml(show.summary).slice(0, 1200) : undefined,
    releaseYear: show.premiered ? Number(show.premiered.slice(0, 4)) : undefined,
    genres: (show.genres ?? []).map(normalizeGenre),
    tags: [],
    runtimeMinutes: show.averageRuntime ?? undefined,
    publicScore: communityRating ?? undefined,
    // rating provenance: TVMaze reports a 0–10 community average
    rating: communityRating != null ? { source: "tvmaze", scale: "0-10", value: communityRating } : undefined,
    languages: show.language ? [show.language] : undefined,
    countries: country ? [country] : undefined,
    studios: network ? [network] : undefined,
    posterUrl: show.image?.original ?? show.image?.medium,
    sourceAttribution: "Data from TVMaze",
    metadataFetchedAt: new Date().toISOString(),
    // cross-provider identity: the IMDb id TVMaze exposes for the show
    externalIds: show.externals?.imdb ? { imdb: show.externals.imdb } : undefined,
  });
}

/** Detail lookups are repeated (library reopen, refresh) — cache 30 min. */
const titleCache = new TTLCache<MediaItem | null>(30 * 60_000);

export class TvMazeProvider implements CatalogueProvider {
  id = "tvmaze";
  label = "TVMaze";

  capabilities = {
    anime: false,
    movies: false,
    series: true,
    games: false,
    books: false,
    contentRatings: false,
    relatedTitles: false,
  };

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, filters?: SearchFilters): Promise<ProviderSearchResult[]> {
    const data = await fetchJson<{ show: TvShow }[]>(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`,
      { signal: filters?.signal },
    );
    return data
      .map((r) => r.show)
      .filter((s) => s && s.id)
      // A2 fix (audit H2): drop fuzzy noise — the normalized title must
      // contain every query token (also drops untitled rows)
      .filter((s) => tvmazeTitleMatchesQuery(s.name, query))
      .slice(0, filters?.limit ?? 8)
      .map((show) => ({ item: toMediaItem(show), sourceLabel: "TVMaze" }));
  }

  async getTitle(providerId: string): Promise<MediaItem | null> {
    return cached(
      titleCache,
      providerId,
      async () => {
        const show = await fetchJson<TvShow>(
          `https://api.tvmaze.com/shows/${encodeURIComponent(providerId)}`,
        );
        return show?.id ? toMediaItem(show) : null;
      },
      (v) => v === null, // failures retry next time
    );
  }

  getAttribution() {
    return {
      name: "TVMaze",
      notice: "Series metadata and artwork from TVMaze's free public API.",
      canonical: "https://www.tvmaze.com/",
    };
  }
}
