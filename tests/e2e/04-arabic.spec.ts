/**
 * E2E flow 4 — Arabic interface & RTL.
 *
 * Arabic is a first-class surface: switching must flip the document to
 * RTL, translate the chrome, keep flows working, and persist across
 * reloads.
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

async function switchToArabic(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("nav").getByRole("button", { name: "Settings" }).click();
  const group = page.getByRole("radiogroup", { name: "Language" });
  await group.getByRole("radio", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

test("switching to Arabic flips the document to RTL and translates the chrome", async ({ page }) => {
  await switchToArabic(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  // nav chrome is translated
  await expect(page.locator("nav").getByRole("button", { name: "الخريطة" })).toBeVisible();
  await expect(page.locator("nav").getByRole("button", { name: "المكتبة" })).toBeVisible();
  await expect(page.locator("nav").getByRole("button", { name: "الإعدادات" })).toBeVisible();
});

test("the Arabic interface keeps the core flows working (search → add)", async ({ page }) => {
  await switchToArabic(page);
  // back to the map — its empty state is translated
  await page.locator("nav").getByRole("button", { name: "الخريطة" }).click();
  await expect(page.getByRole("heading", { name: "ورقة بيضاء" })).toBeVisible();
  // open the add dialog from the empty state (Arabic CTA)
  await page.getByRole("button", { name: "أضف العنوان الأول" }).click();
  await page.getByPlaceholder("ابحث في الكتالوج…").fill("cowboy");
  await expect(
    page
      .locator("dialog li, [role='dialog'] li")
      .filter({ hasText: "Cowboy Bebop" })
      .first(),
  ).toBeVisible({ timeout: 15_000 });
  // the Add button is translated
  await page
    .locator("dialog li, [role='dialog'] li")
    .filter({ hasText: "Cowboy Bebop" })
    .first()
    .getByRole("button", { name: "أضف" })
    .click();
  await closeDialog(page);
  await expect(page.getByText("عنوان واحد")).toBeVisible({ timeout: 15_000 });
});

test("switching back to English restores LTR and the English chrome", async ({ page }) => {
  await switchToArabic(page);
  await page.getByRole("radiogroup", { name: "اللغة" }).getByRole("radio", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("nav").getByRole("button", { name: "Library" })).toBeVisible();
});

test("the language choice persists across reloads", async ({ page }) => {
  await switchToArabic(page);
  await page.reload();
  await waitForApp(page);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("nav").getByRole("button", { name: "الخريطة" })).toBeVisible();
});

/* ------------------- A2: the Arabic-first search aid (C3) ------------------- */

test("an Arabic query with few live results offers Latin-script re-search chips", async ({ page }) => {
  // Override the provider mocks (later routes win): Arabic-script queries get
  // EMPTY live answers — Latin-script queries get a Totoro row. This is the
  // real-world shape: Latin catalogues cannot answer Arabic queries.
  const ARABIC = /[\u0600-\u06FF]/;
  await page.route("**/graphql.anilist.co/*", (route) => {
    const body = route.request().postDataJSON() as
      | { variables?: { s?: string } }
      | null;
    const q = body?.variables?.s ?? "";
    const media = ARABIC.test(q)
      ? []
      : [
          {
            id: 42,
            title: { romaji: "My Neighbor Totoro", english: "My Neighbor Totoro" },
            description: "Two girls meet forest spirits. Test synopsis.",
            startDate: { year: 1988 },
            genres: ["Fantasy"],
            tags: [],
            format: "TV",
            siteUrl: "https://anilist.co/anime/42",
            isAdult: false,
            countryOfOrigin: "JP",
          },
        ];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { Page: { media } } }),
    });
  });
  await page.route("**/api.tvmaze.com/search/shows*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ARABIC.test(q) ? [] : [{ show: { id: 5, name: "My Neighbor Totoro", premiered: "1988-04-16" } }]),
    });
  });

  await switchToArabic(page);
  await page.locator("nav").getByRole("button", { name: "الخريطة" }).click();
  await page.getByRole("button", { name: "أضف العنوان الأول" }).click();
  // search with an Arabic title — live sources come back empty…
  await page.getByPlaceholder("ابحث في الكتالوج…").fill("توتورو");
  // …so the aid panel appears with the honest Arabic explanation…
  await expect(page.getByText("نتائج حية قليلة لبحث بالعربية")).toBeVisible({ timeout: 15_000 });
  // …including the bilingual chip (Arabic label, Latin re-search)
  const chip = page.getByRole("button", { name: "جاري توتورو" });
  await expect(chip).toBeVisible();
  // one tap re-searches in Latin script and live results appear
  await chip.click();
  await expect(
    page
      .locator("dialog li, [role='dialog'] li")
      .filter({ hasText: "My Neighbor Totoro" })
      .first(),
  ).toBeVisible({ timeout: 15_000 });
});
