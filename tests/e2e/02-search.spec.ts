/**
 * E2E flow 2 — Federated search → add → rate → map updates.
 *
 * Providers are mocked at the network layer (AniList GraphQL, TVMaze,
 * Open Library, Wikidata + graceful-empty secondaries). The transparency
 * contract — every result labelled with its source — is asserted here.
 */

import { test, expect } from "@playwright/test";
import {
  addTitleFromSearch,
  closeDialog,
  mockProviders,
  openAddDialog,
  searchCatalogueFor,
  skipOnboarding,
  waitForApp,
} from "./fixtures";

test.beforeEach(async ({ page }) => {
  await mockProviders(page);
  await page.goto("/");
  await waitForApp(page);
  await skipOnboarding(page);
});

test("search returns labelled results from the (mocked) live providers", async ({ page }) => {
  await openAddDialog(page);
  await searchCatalogueFor(page, "breaking bad");
  // TVMaze row is present and carries its source chip
  const row = page
    .locator("dialog li, [role='dialog'] li")
    .filter({ hasText: "Breaking Bad" })
    .first();
  await expect(row).toBeVisible();
  await expect(row.getByText("TVMaze", { exact: true })).toBeVisible();
});

test("every result is source-labelled across providers (anime + books)", async ({ page }) => {
  await openAddDialog(page);
  // anime source
  await searchCatalogueFor(page, "cowboy");
  const animeRow = page
    .locator("dialog li, [role='dialog'] li")
    .filter({ hasText: "Cowboy Bebop" })
    .first();
  await expect(animeRow).toBeVisible();
  await expect(animeRow.getByText("AniList", { exact: true })).toBeVisible();
  // books source
  await searchCatalogueFor(page, "little prince");
  const bookRow = page
    .locator("dialog li, [role='dialog'] li")
    .filter({ hasText: "The Little Prince" })
    .first();
  await expect(bookRow).toBeVisible();
  await expect(bookRow.getByText("Open Library", { exact: true })).toBeVisible();
});

test("adding a title from search updates the library and the map stats", async ({ page }) => {
  await openAddDialog(page);
  await searchCatalogueFor(page, "cowboy");
  await addTitleFromSearch(page, "Cowboy Bebop");
  await closeDialog(page);
  // the map (formerly empty) now counts exactly one title
  await expect(page.getByText("1 title")).toBeVisible({ timeout: 15_000 });
  // and the library screen lists it
  await page.locator("nav").getByRole("button", { name: "Library" }).click();
  await expect(page.getByText("1 title, stored only on this device.")).toBeVisible();
  await expect(page.getByText("Cowboy Bebop")).toBeVisible();
});

/* ---------------------- A2: search pagination ("show more") ---------------------- */

test("a full paginated provider page offers Show more, which loads page 2", async ({ page }) => {
  // Override AniList AFTER the shared mocks (later routes win in Playwright):
  // page 1 → 8 anime (fills the per-provider cap → canLoadMore), page 2 →
  // one new title that only exists on the second page.
  await page.route("**/graphql.anilist.co/*", (route) => {
    const body = route.request().postDataJSON() as { variables?: { p?: number } } | null;
    const pageNo = body?.variables?.p ?? 1;
    const media =
      pageNo >= 2
        ? [
            {
              id: 9001,
              title: { romaji: "Second Page Sirius", english: "Second Page Sirius" },
              description: "Only reachable via Show more. Test synopsis.",
              startDate: { year: 2015 },
              genres: ["Sci-Fi"],
              tags: [],
              averageScore: 80,
              format: "TV",
              siteUrl: "https://anilist.co/anime/9001",
              isAdult: false,
              countryOfOrigin: "JP",
            },
          ]
        : Array.from({ length: 8 }, (_, i) => ({
            id: 5000 + i,
            title: { romaji: `Deep Tail ${i + 1}`, english: `Deep Tail ${i + 1}` },
            description: "Page-one result. Test synopsis.",
            startDate: { year: 2010 },
            genres: ["Drama"],
            tags: [],
            averageScore: 75,
            format: "TV",
            siteUrl: `https://anilist.co/anime/${5000 + i}`,
            isAdult: false,
            countryOfOrigin: "JP",
          }));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { Page: { media } } }),
    });
  });

  await openAddDialog(page);
  await searchCatalogueFor(page, "deep tail");
  // 8/8 from a paginated provider → the Show more button appears
  const showMore = page.getByRole("button", { name: "Show more results" });
  await expect(showMore).toBeVisible({ timeout: 15_000 });
  // page 2 loads the title that only exists there (anime + manga jobs both
  // return it — the mock serves the same payload to either AniList query)
  await showMore.click();
  await expect(
    page.locator("dialog li, [role='dialog'] li").filter({ hasText: "Second Page Sirius" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // page-one results are still on screen (accumulated, not replaced)
  await expect(
    page.locator("dialog li, [role='dialog'] li").filter({ hasText: "Deep Tail 1" }).first(),
  ).toBeVisible();
});
