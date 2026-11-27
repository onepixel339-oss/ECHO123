/**
 * E2E flow 7 — the 1.3.0 product scope: no AI surface, and the local-only
 * app shows no account/sync UI when cloud sync is unconfigured.
 *
 * The username + password account/sync surface renders ONLY when the
 * Supabase public config is present; on this unconfigured build the entire
 * section must be absent — the local-first spine. The AI removal (Ask ECHO
 * nav entry, any AI copy) is locked here as a regression gate.
 */

import { test, expect } from "@playwright/test";
import { mockProviders, skipOnboarding, waitForApp } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await mockProviders(page);
  await page.goto("/");
  await waitForApp(page);
  await skipOnboarding(page);
});

test("the primary navigation has exactly five tabs — Ask ECHO is gone", async ({ page }) => {
  const expected = ["Map", "Discover", "Library", "Taste", "Settings"];
  for (const name of expected) {
    await expect(page.locator("nav").getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.locator("nav").getByRole("button", { name: "Ask ECHO" })).toHaveCount(0);
  // on the desktop viewport each tab renders once (the mobile bottom nav
  // is display:none and excluded from the a11y tree); the removed Ask tab
  // renders nowhere. The mobile nav is generated from the same NAV array.
  for (const name of expected) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(1);
  }
  await expect(page.getByRole("button", { name: "Ask ECHO" })).toHaveCount(0);
});

test("Settings shows no account or sync surface when sync is unconfigured", async ({ page }) => {
  await page.locator("nav").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Account & sync" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sync status" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Devices" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
});

test("no AI feature copy appears anywhere in the app", async ({ page }) => {
  // Taste keeps its deterministic insights; the AI companion is gone
  await page.locator("nav").getByRole("button", { name: "Taste" }).click();
  await expect(page.getByText("Taste Companion")).toHaveCount(0);
  await expect(page.getByText("Read my map")).toHaveCount(0);
  // the app never claims AI features
  for (const view of ["Map", "Discover", "Library", "Taste", "Settings"]) {
    await page.locator("nav").getByRole("button", { name: view, exact: true }).click();
    await expect(page.getByText(/Ask ECHO/i)).toHaveCount(0);
  }
});

test("Arabic Settings also stays free of the account surface (RTL parity)", async ({ page }) => {
  await page.locator("nav").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radiogroup", { name: "Language" }).getByRole("radio", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "الحساب والمزامنة" })).toHaveCount(0);
  // the localized settings sections still render
  await expect(page.getByRole("heading", { name: "اللغة" })).toBeVisible();
});
