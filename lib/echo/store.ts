/**
 * ECHO — Central client store (zustand) with write-through IndexedDB
 * persistence. All mutations update local storage first, then state.
 */

"use client";

import React from "react";
import { create } from "zustand";
import * as db from "./localdb";
import {
  emitLocalMutation as emitMutation,
  emitLocalCleared,
  SYNCED_SETTINGS_KEYS,
} from "./sync/localMutations";
import { makeId } from "./ids";
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  type AppSettings,
  type LibraryStatus,
  type MediaItem,
  type Rating,
  type TasteFeedback,
  type UserMediaEntry,
  type FeedbackValue,
  type MapLayoutState,
  type Language,
} from "./types";
import { DEMO_CATALOGUE, DEMO_LIBRARY, demoToMediaItem } from "./data/demoCatalogue";
import { getTitleByLocalId, clearCatalogueCaches } from "./providers";
import {
  normalizeUserToggle,
  setProviderToggles,
  refreshGateIdsForPrefix,
  isProviderEnabled,
} from "./providers/registry";
import { findBestMatch } from "./providers/match";
import { syncCatalogShards } from "./catalogShards";
import type { MatchCandidateSummary } from "./types";

const now = () => new Date().toISOString();

export type View = "map" | "discover" | "library" | "taste" | "settings";

interface EchoState {
  hydrated: boolean;
  storageOk: boolean;
  settings: AppSettings;
  media: MediaItem[];
  entries: UserMediaEntry[];
  feedback: TasteFeedback[];
  mapLayout: MapLayoutState | null;
  demoEntries: UserMediaEntry[];
  /** session-only preview items (Discover/coming-soon cards opened in the
   *  details drawer before being added to the library) — never persisted */
  stagedMedia: MediaItem[];
  view: View;
  selectedLocalId: string | null;
  selectedEdge: { a: string; b: string } | null;
  bootedWithOnboarding: boolean;
  addDialogOpen: boolean;

  hydrate: () => Promise<void>;
  setView: (v: View) => void;
  /** select a title; pass `item` when it is not in the library yet (Discover,
   *  coming-soon) so the details drawer can render it without adding it. */
  select: (localId: string | null, item?: MediaItem) => void;
  selectEdge: (edge: { a: string; b: string } | null) => void;
  setAddDialog: (open: boolean) => void;

  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setLanguage: (lang: Language) => Promise<void>;
  /** Toggle a catalogue provider (registry-validated; hard-gated providers
   *  cannot be switched on). Returns false when the toggle was refused. */
  setProviderToggle: (id: string, enabled: boolean) => Promise<boolean>;

  addTitle: (
    item: MediaItem,
    init?: { status?: LibraryStatus; rating?: Rating; isFavourite?: boolean },
  ) => Promise<UserMediaEntry>;
  updateEntry: (id: string, patch: Partial<UserMediaEntry>) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  recordFeedback: (
    mediaLocalId: string,
    value: FeedbackValue,
    source: TasteFeedback["source"],
  ) => Promise<void>;
  dismissInsight: (featureKey: string) => Promise<void>;
  undoDismissInsight: (featureKey: string) => Promise<void>;

  seedFromOnboarding: (
    picks: { item: MediaItem; rating?: Rating; isFavourite?: boolean }[],
    prefs: { featureKey: string; value: "liked" | "disliked" }[],
  ) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  resetOnboarding: () => Promise<void>;

  startDemo: () => Promise<void>;
  exitDemo: (keepTitles: boolean) => Promise<void>;

  /** Replace a manual media record with its real provider record (keeps the
   *  entry, its rating/note, and repoints taste feedback). */
  linkEntryMedia: (entryId: string, media: MediaItem) => Promise<boolean>;
  /** Patch a stored media record in place (e.g. persist an auto-translated
   *  Arabic title so every card shows it, offline included). */
  patchMedia: (localId: string, patch: Partial<MediaItem>) => Promise<void>;
  /** Try to auto-link a manual entry to a confident provider match. */
  autoLinkEntry: (entryId: string) => Promise<MediaItem | null>;
  /** Refresh metadata (posters, genres, synopsis) for every provider-backed
   *  title, and auto-link manual entries. Returns a progress summary. */
  refreshLibraryMetadata: () => Promise<{
    refreshed: number;
    linked: number;
    failed: number;
  }>;

  saveMapLayout: (layout: MapLayoutState) => Promise<void>;
  clearMapLayout: () => Promise<void>;

  clearAllData: () => Promise<void>;
  importBundle: (
    data: unknown,
    mode: "merge" | "replace",
  ) => Promise<{ ok: boolean; count?: number; error?: string }>;
}

function detectLanguage(): Language {
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("ar")) {
    return "ar";
  }
  return "en";
}

export const useEchoStore = create<EchoState>((set, get) => ({
  hydrated: false,
  storageOk: true,
  settings: { ...DEFAULT_SETTINGS },
  media: [],
  entries: [],
  feedback: [],
  mapLayout: null,
  demoEntries: [],
  stagedMedia: [],
  view: "map",
  selectedLocalId: null,
  selectedEdge: null,
  bootedWithOnboarding: false,
  addDialogOpen: false,

  hydrate: async () => {
    const storageOk = await db.storageAvailable();
    if (!storageOk) {
      set({ hydrated: true, storageOk: false });
      return;
    }
    // v1 → v2 additive catalog migration (creates works/workLinks stores,
    // stamps v2 fields onto stored records — never destructive). Runs before
    // the records are read into state so the app boots on enriched data.
    try {
      await db.runCatalogMigrationV2();
    } catch {
      // non-fatal: stored v1 records remain fully usable without v2 fields
    }
    const [settings, media, entries, feedback, mapLayout, demoEntries] =
      await Promise.all([
        db.getSettings(),
        db.getAllMedia(),
        db.getAllEntries(),
        db.getAllFeedback(),
        db.getMapLayout(),
        db.getAllDemoEntries(),
      ]);
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    if (!settings) merged.language = detectLanguage();
    // v1 → v2: the catalogue expanded (games + books); additive for existing users
    const migrated = migrateSettings(merged);
    if (settings && migrated !== merged) await db.saveSettings(migrated);
    // push the user's provider toggles into the license gate (defaults
    // apply when the user never touched them)
    setProviderToggles(migrated.providerToggles ?? null);
    set({
      hydrated: true,
      storageOk: true,
      settings: migrated,
      media,
      entries,
      feedback,
      mapLayout,
      demoEntries,
      bootedWithOnboarding: !migrated.onboarded,
      view: "map",
    });
    // versioned public catalog shards (static JSON → IndexedDB catalog
    // store): fire-and-forget sync — offline or missing manifest simply
    // keeps the current shard copy; failures never block boot
    void syncCatalogShards().catch(() => undefined);
  },

  setView: (v) => set({ view: v, selectedEdge: null }),
  select: (localId, item) => {
    if (item && !get().media.some((m) => m.localId === item.localId)) {
      // session-only preview so the details drawer can render non-library cards
      const staged = [
        { ...item },
        ...get().stagedMedia.filter((m) => m.localId !== item.localId),
      ].slice(0, 40);
      set({ selectedLocalId: localId, stagedMedia: staged });
      return;
    }
    set({ selectedLocalId: localId });
  },
  selectEdge: (edge) => set({ selectedEdge: edge }),
  setAddDialog: (open) => set({ addDialogOpen: open }),

  updateSettings: async (patch) => {
    const prev = get().settings;
    const next = { ...prev, ...patch };
    set({ settings: next });
    await db.saveSettings(next);
    // sync emission: only when a synced field actually changed
    if (SYNCED_SETTINGS_KEYS.some((k) => !Object.is(prev[k], next[k]))) {
      const record: Record<string, unknown> = {};
      for (const k of SYNCED_SETTINGS_KEYS) record[k] = next[k];
      emitMutation({ entity: "user_settings", op: "upsert", recordId: "settings", record });
    }
  },

  setLanguage: async (lang) => {
    await get().updateSettings({ language: lang });
  },

  setProviderToggle: async (id, enabled) => {
    const normalized = normalizeUserToggle(id, enabled);
    if (!normalized) return false; // unknown or hard-gated provider
    const toggles = { ...(get().settings.providerToggles ?? {}), [id]: normalized.enabled };
    await get().updateSettings({ providerToggles: toggles });
    setProviderToggles(toggles);
    clearCatalogueCaches(); // gating changes take effect immediately
    return true;
  },

  addTitle: async (item, init) => {
    const entry: UserMediaEntry = {
      id: makeId("entry"),
      mediaLocalId: item.localId,
      status: init?.status ?? "planned",
      rating: init?.rating,
      isFavourite: init?.isFavourite ?? false,
      userTags: [],
      addedAt: now(),
      updatedAt: now(),
      completedAt: init?.status === "completed" ? now() : undefined,
    };
    // persist media record (idempotent put)
    await db.putMedia([item]);
    await db.putEntries([entry]);
    if (entry.rating !== undefined) {
      const fb: TasteFeedback = {
        id: makeId("fb"),
        mediaLocalId: item.localId,
        value: entry.rating >= 4 ? "liked" : entry.rating <= 2 ? "disliked" : "liked",
        source: "rating",
        createdAt: now(),
      };
      await db.putFeedback([fb]);
      set({ feedback: [...get().feedback, fb] });
      emitMutation({ entity: "feedback", op: "upsert", recordId: fb.id, record: fb as unknown as Record<string, unknown> });
    }
    if (entry.isFavourite) {
      const fb: TasteFeedback = {
        id: makeId("fb"),
        mediaLocalId: item.localId,
        value: "liked",
        source: "favourite",
        createdAt: now(),
      };
      await db.putFeedback([fb]);
      set({ feedback: [...get().feedback, fb] });
      emitMutation({ entity: "feedback", op: "upsert", recordId: fb.id, record: fb as unknown as Record<string, unknown> });
    }
    set({
      media: get().media.some((m) => m.localId === item.localId)
        ? get().media
        : [...get().media, item],
      entries: [...get().entries, entry],
    });
    emitMutation({ entity: "media_items", op: "upsert", recordId: item.localId, record: item as unknown as Record<string, unknown> });
    emitMutation({ entity: "entries", op: "upsert", recordId: entry.id, record: entry as unknown as Record<string, unknown> });
    return entry;
  },

  updateEntry: async (id, patch) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    const next: UserMediaEntry = { ...entry, ...patch, updatedAt: now() };
    if (patch.status === "completed" && !entry.completedAt) {
      next.completedAt = now();
    }
    await db.putEntries([next]);
    set({ entries: get().entries.map((e) => (e.id === id ? next : e)) });
    emitMutation({ entity: "entries", op: "upsert", recordId: id, record: next as unknown as Record<string, unknown> });

    // explicit rating changes produce taste feedback records
    if (patch.rating !== undefined && patch.rating !== entry.rating) {
      const fb: TasteFeedback = {
        id: makeId("fb"),
        mediaLocalId: next.mediaLocalId,
        value: patch.rating >= 4 ? "liked" : patch.rating <= 2 ? "disliked" : "liked",
        source: "rating",
        createdAt: now(),
      };
      await db.putFeedback([fb]);
      set({ feedback: [...get().feedback, fb] });
      emitMutation({ entity: "feedback", op: "upsert", recordId: fb.id, record: fb as unknown as Record<string, unknown> });
    }
    if (patch.isFavourite !== undefined && patch.isFavourite !== entry.isFavourite) {
      const fb: TasteFeedback = {
        id: makeId("fb"),
        mediaLocalId: next.mediaLocalId,
        value: patch.isFavourite ? "liked" : "disliked",
        source: "favourite",
        createdAt: now(),
      };
      await db.putFeedback([fb]);
      set({ feedback: [...get().feedback, fb] });
      emitMutation({ entity: "feedback", op: "upsert", recordId: fb.id, record: fb as unknown as Record<string, unknown> });
    }
  },

  removeEntry: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    await db.deleteEntries([id]);
    const relatedFb = get().feedback.filter((f) => f.mediaLocalId === entry.mediaLocalId);
    if (relatedFb.length) await db.deleteFeedback(relatedFb.map((f) => f.id));
    set({
      entries: get().entries.filter((e) => e.id !== id),
      feedback: get().feedback.filter((f) => f.mediaLocalId !== entry.mediaLocalId),
    });
    emitMutation({ entity: "entries", op: "delete", recordId: id });
    for (const f of relatedFb) {
      emitMutation({ entity: "feedback", op: "delete", recordId: f.id });
    }
  },

  recordFeedback: async (mediaLocalId, value, source) => {
    const fb: TasteFeedback = {
      id: makeId("fb"),
      mediaLocalId,
      value,
      source,
      createdAt: now(),
    };
    await db.putFeedback([fb]);
    set({ feedback: [...get().feedback, fb] });
    emitMutation({ entity: "feedback", op: "upsert", recordId: fb.id, record: fb as unknown as Record<string, unknown> });
  },

  dismissInsight: async (featureKey) => {
    const dismissed = [...new Set([...get().settings.dismissedInsights, featureKey])];
    await get().updateSettings({ dismissedInsights: dismissed });
  },

  undoDismissInsight: async (featureKey) => {
    const dismissed = get().settings.dismissedInsights.filter((k) => k !== featureKey);
    await get().updateSettings({ dismissedInsights: dismissed });
  },

  seedFromOnboarding: async (picks, prefs) => {
    const media: MediaItem[] = [];
    const entries: UserMediaEntry[] = [];
    const feedback: TasteFeedback[] = [];
    for (const pick of picks) {
      const entry: UserMediaEntry = {
        id: makeId("entry"),
        mediaLocalId: pick.item.localId,
        status: "completed",
        rating: pick.rating,
        isFavourite: pick.isFavourite ?? false,
        userTags: [],
        addedAt: now(),
        updatedAt: now(),
        completedAt: now(),
      };
      media.push(pick.item);
      entries.push(entry);
      if (entry.rating !== undefined) {
        feedback.push({
          id: makeId("fb"),
          mediaLocalId: pick.item.localId,
          value: entry.rating >= 4 ? "liked" : entry.rating <= 2 ? "disliked" : "liked",
          source: "rating",
          createdAt: now(),
        });
      }
    }
    for (const p of prefs) {
      feedback.push({
        id: makeId("fb"),
        featureKey: p.featureKey,
        value: p.value,
        source: "onboarding",
        createdAt: now(),
      });
    }
    if (media.length) await db.putMedia(media);
    if (entries.length) await db.putEntries(entries);
    if (feedback.length) await db.putFeedback(feedback);
    set((s) => ({
      media: [...s.media, ...media.filter((m) => !s.media.some((x) => x.localId === m.localId))],
      entries: [...s.entries, ...entries],
      feedback: [...s.feedback, ...feedback],
    }));
    for (const m of media) emitMutation({ entity: "media_items", op: "upsert", recordId: m.localId, record: m as unknown as Record<string, unknown> });
    for (const e of entries) emitMutation({ entity: "entries", op: "upsert", recordId: e.id, record: e as unknown as Record<string, unknown> });
    for (const f of feedback) emitMutation({ entity: "feedback", op: "upsert", recordId: f.id, record: f as unknown as Record<string, unknown> });
  },

  completeOnboarding: async () => {
    await get().updateSettings({ onboarded: true, onboardedAt: now() });
    set({ bootedWithOnboarding: false, view: "map" });
  },

  resetOnboarding: async () => {
    await get().updateSettings({ onboarded: false });
    set({ bootedWithOnboarding: true });
  },

  startDemo: async () => {
    // build the pre-built demo universe in the ISOLATED demo stores
    const bySeedId = new Map(DEMO_CATALOGUE.map((s) => [s.id, s]));
    const entries: UserMediaEntry[] = DEMO_LIBRARY.map((seed) => {
      const item = demoToMediaItem(bySeedId.get(seed.seedId)!);
      return {
        id: makeId("demo"),
        mediaLocalId: item.localId,
        status: seed.status,
        rating: seed.rating,
        isFavourite: seed.fav ?? false,
        userTags: [],
        addedAt: now(),
        updatedAt: now(),
        completedAt: seed.status === "completed" ? now() : undefined,
      };
    });
    await db.putDemoEntries(entries);
    await get().updateSettings({ demoMode: true, onboarded: true, onboardedAt: get().settings.onboardedAt ?? now() });
    set({ demoEntries: entries, bootedWithOnboarding: false, view: "map" });
  },

  exitDemo: async (keepTitles) => {
    const demoEntries = get().demoEntries;
    if (keepTitles && demoEntries.length) {
      // merge demo picks into the real library (user explicitly chose to keep)
      const byLocalId = new Map(
        DEMO_CATALOGUE.map((s) => {
          const item = demoToMediaItem(s);
          return [item.localId, item];
        }),
      );
      const media: MediaItem[] = [];
      const entries: UserMediaEntry[] = [];
      for (const de of demoEntries) {
        const item = byLocalId.get(de.mediaLocalId);
        if (!item) continue;
        media.push(item);
        entries.push({ ...de, id: makeId("entry"), addedAt: now(), updatedAt: now() });
      }
      if (media.length) await db.putMedia(media);
      if (entries.length) await db.putEntries(entries);
      set((s) => ({
        media: [...s.media, ...media.filter((m) => !s.media.some((x) => x.localId === m.localId))],
        entries: [...s.entries, ...entries],
      }));
      for (const m of media) emitMutation({ entity: "media_items", op: "upsert", recordId: m.localId, record: m as unknown as Record<string, unknown> });
      for (const e of entries) emitMutation({ entity: "entries", op: "upsert", recordId: e.id, record: e as unknown as Record<string, unknown> });
    }
    await db.clearDemoData();
    await get().updateSettings({ demoMode: false });
    set({ demoEntries: [], view: "map" });
  },

  saveMapLayout: async (layout) => {
    await db.saveMapLayout(layout);
    set({ mapLayout: layout });
  },

  linkEntryMedia: async (entryId, media) => {
    const entry = get().entries.find((e) => e.id === entryId);
    if (!entry) return false;
    const oldLocalId = entry.mediaLocalId;
    if (oldLocalId === media.localId) return true;
    // never fold two entries onto the same media record
    if (get().entries.some((e) => e.id !== entryId && e.mediaLocalId === media.localId)) {
      return false;
    }

    const updatedEntry: UserMediaEntry = {
      ...entry,
      mediaLocalId: media.localId,
      updatedAt: now(),
      // a successful link resolves any pending review flag
      matchReview: undefined,
    };
    await db.putEntries([updatedEntry]);
    await db.putMedia([media]);

    // repoint taste feedback so the taste profile keeps its evidence
    const related = get().feedback.filter((f) => f.mediaLocalId === oldLocalId);
    let movedFeedback: TasteFeedback[] = [];
    if (related.length) {
      const moved = related.map((f) => ({ ...f, mediaLocalId: media.localId }));
      movedFeedback = moved;
      await db.putFeedback(moved);
      await db.deleteFeedback(related.map((f) => f.id));
      const other = get().feedback.filter((f) => f.mediaLocalId !== oldLocalId);
      set({ feedback: [...other, ...moved] });
    }

    // drop the manual record once the provider record owns the entry
    const oldMedia = get().media.find((m) => m.localId === oldLocalId);
    const stillReferenced = get().entries.some((e) => e.mediaLocalId === oldLocalId);
    if (oldMedia?.provider === "manual" && !stillReferenced) {
      await db.deleteMedia([oldLocalId]);
    }

    set({
      entries: get().entries.map((e) => (e.id === entryId ? updatedEntry : e)),
      media: get().media.some((m) => m.localId === media.localId)
        ? get().media.map((m) => (m.localId === media.localId ? media : m))
        : [...get().media.filter((m) => m.localId !== oldLocalId), media],
    });
    emitMutation({ entity: "entries", op: "upsert", recordId: entryId, record: updatedEntry as unknown as Record<string, unknown> });
    emitMutation({ entity: "media_items", op: "upsert", recordId: media.localId, record: media as unknown as Record<string, unknown> });
    for (const f of movedFeedback) emitMutation({ entity: "feedback", op: "upsert", recordId: f.id, record: f as unknown as Record<string, unknown> });
    for (const f of related) emitMutation({ entity: "feedback", op: "delete", recordId: f.id });
    if (oldMedia?.provider === "manual" && !stillReferenced) {
      emitMutation({ entity: "media_items", op: "delete", recordId: oldLocalId });
    }
    return true;
  },

  patchMedia: async (localId, patch) => {
    const current = get().media.find((m) => m.localId === localId);
    if (!current) return; // only stored records (library titles) are patchable
    const next: MediaItem = { ...current, ...patch, localId }; // localId is immutable
    await db.putMedia([next]);
    set({ media: get().media.map((m) => (m.localId === localId ? next : m)) });
    emitMutation({ entity: "media_items", op: "upsert", recordId: localId, record: next as unknown as Record<string, unknown> });
  },

  autoLinkEntry: async (entryId) => {
    const entry = get().entries.find((e) => e.id === entryId);
    if (!entry) return null;
    const media = get().media.find((m) => m.localId === entry.mediaLocalId);
    if (!media || media.provider !== "manual") return null;
    const outcome = await findBestMatch(media);
    if (outcome.status === "none") return null;

    if (outcome.status === "ambiguous") {
      // several distinct works could be this title — keep the manual record
      // separate and flag the entry for manual review
      const candidates: MatchCandidateSummary[] = outcome.candidates.map((c) => ({
        localId: c.item.localId,
        provider: c.item.provider,
        providerId: c.item.providerId,
        title: c.item.title,
        releaseYear: c.item.releaseYear,
        mediaType: c.item.mediaType,
      }));
      const flagged: UserMediaEntry = {
        ...entry,
        matchReview: { flaggedAt: now(), candidates },
        updatedAt: now(),
      };
      await db.putEntries([flagged]);
      set({ entries: get().entries.map((e) => (e.id === entryId ? flagged : e)) });
      emitMutation({ entity: "entries", op: "upsert", recordId: entryId, record: flagged as unknown as Record<string, unknown> });
      return null;
    }

    const ok = await get().linkEntryMedia(entryId, outcome.item);
    return ok ? outcome.item : null;
  },

  refreshLibraryMetadata: async () => {
    let refreshed = 0;
    let linked = 0;
    let failed = 0;

    // 1) refresh every provider-backed title (posters, genres, synopsis).
    //    Providers disabled by the license gate are SKIPPED (not failed):
    //    their stored records stay exactly as they are.
    const providerBacked = [...new Set(get().entries.map((e) => e.mediaLocalId))]
      .map((id) => get().media.find((m) => m.localId === id))
      .filter(
        (m): m is MediaItem =>
          Boolean(m) &&
          m!.provider !== "manual" &&
          m!.provider !== "echo-demo" &&
          (() => {
            const prefix = m!.localId.split(":")[0];
            const gateIds = refreshGateIdsForPrefix(prefix);
            return gateIds.length > 0 && gateIds.every((gid) => isProviderEnabled(gid));
          })(),
      );

    const CONCURRENCY = 3;
    const queue = [...providerBacked];
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        const fresh = await getTitleByLocalId(item.localId);
        if (fresh) {
          await db.putMedia([fresh]);
          set({ media: get().media.map((m) => (m.localId === fresh.localId ? fresh : m)) });
          emitMutation({ entity: "media_items", op: "upsert", recordId: fresh.localId, record: fresh as unknown as Record<string, unknown> });
          refreshed++;
        } else {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // 2) auto-link manual entries to their real catalogue records
    const manualEntryIds = get().entries
      .filter((e) => {
        const m = get().media.find((x) => x.localId === e.mediaLocalId);
        return m?.provider === "manual";
      })
      .map((e) => e.id);
    for (const id of manualEntryIds) {
      const linkedItem = await get().autoLinkEntry(id);
      if (linkedItem) linked++;
    }

    return { refreshed, linked, failed };
  },

  clearMapLayout: async () => {
    await db.saveMapLayout({ positions: {}, zoom: 1, panX: 0, panY: 0, activeFilters: {}, layoutVersion: 1, updatedAt: now() });
    set({ mapLayout: null });
  },

  clearAllData: async () => {
    await db.clearAllLocalData();
    emitLocalCleared(); // the sync engine quarantines the outbox + resets device state
    set({
      settings: { ...DEFAULT_SETTINGS, language: get().settings.language },
      media: [],
      entries: [],
      feedback: [],
      mapLayout: null,
      demoEntries: [],
      view: "map",
      selectedLocalId: null,
      selectedEdge: null,
      bootedWithOnboarding: true,
    });
  },

  importBundle: async (data, mode) => {
    const { validateBundle, applyBundle } = await import("./exportimport");
    const parsed = validateBundle(data);
    if (!parsed.ok) return { ok: false, error: "invalid" };
    const count = await applyBundle(parsed.data, mode, {
      putMedia: db.putMedia,
      putEntries: db.putEntries,
      putFeedback: db.putFeedback,
      getAllEntries: db.getAllEntries,
      getAllMedia: db.getAllMedia,
      getAllFeedback: db.getAllFeedback,
      putWorks: db.putWorks,
      putWorkLinks: db.putWorkLinks,
    });
    // re-hydrate from storage to reflect merge/replace
    const [media, entries, feedback] = await Promise.all([
      db.getAllMedia(),
      db.getAllEntries(),
      db.getAllFeedback(),
    ]);
    // sync emission: upserts for everything now present that differs, and —
    // in replace mode — deletes for records that vanished
    const before = get();
    const seen = (arr: Array<{ id?: string; localId?: string }>, key: "id" | "localId") =>
      new Map(arr.map((r) => [r[key], r]));
    const prevMedia = seen(before.media, "localId");
    for (const m of media) {
      const p = prevMedia.get(m.localId);
      if (!p || JSON.stringify(p) !== JSON.stringify(m)) {
        emitMutation({ entity: "media_items", op: "upsert", recordId: m.localId, record: m as unknown as Record<string, unknown> });
      }
    }
    const prevEntries = seen(before.entries, "id");
    for (const e of entries) {
      const p = prevEntries.get(e.id);
      if (!p || JSON.stringify(p) !== JSON.stringify(e)) {
        emitMutation({ entity: "entries", op: "upsert", recordId: e.id, record: e as unknown as Record<string, unknown> });
      }
    }
    const prevFeedback = seen(before.feedback, "id");
    for (const f of feedback) {
      const p = prevFeedback.get(f.id);
      if (!p || JSON.stringify(p) !== JSON.stringify(f)) {
        emitMutation({ entity: "feedback", op: "upsert", recordId: f.id, record: f as unknown as Record<string, unknown> });
      }
    }
    if (mode === "replace") {
      const nowMedia = seen(media, "localId");
      for (const m of before.media) {
        if (!nowMedia.has(m.localId)) emitMutation({ entity: "media_items", op: "delete", recordId: m.localId });
      }
      const nowEntries = seen(entries, "id");
      for (const e of before.entries) {
        if (!nowEntries.has(e.id)) emitMutation({ entity: "entries", op: "delete", recordId: e.id });
      }
      const nowFeedback = seen(feedback, "id");
      for (const f of before.feedback) {
        if (!nowFeedback.has(f.id)) emitMutation({ entity: "feedback", op: "delete", recordId: f.id });
      }
    }
    set({ media, entries, feedback });
    // Replace mode is a full restore: the backed-up settings come back too
    // (NF-1). Merge mode never touches settings — that is its contract.
    if (mode === "replace" && parsed.data.settings) {
      const restored = parsed.data.settings;
      await get().updateSettings(restored);
      if (restored.providerToggles) {
        setProviderToggles(restored.providerToggles);
      }
    }
    return { ok: true, count };
  },
}));

// ---------- selectors / derived helpers ----------

/** Active library depending on demo mode (demo universe is isolated). */
export function useActiveLibrary() {
  const demoMode = useEchoStore((s) => s.settings.demoMode);
  const media = useEchoStore((s) => s.media);
  const entries = useEchoStore((s) => s.entries);
  const demoEntries = useEchoStore((s) => s.demoEntries);
  const demoMediaMap = React.useMemo(() => {
    const map = new Map<string, MediaItem>();
    for (const seed of DEMO_CATALOGUE) {
      const item = demoToMediaItem(seed);
      map.set(item.localId, item);
    }
    return map;
  }, []);
  if (!demoMode) return { media, entries, mediaById: new Map(media.map((m) => [m.localId, m])) };
  return {
    media: [...demoMediaMap.values()],
    entries: demoEntries,
    mediaById: demoMediaMap,
  };
}
