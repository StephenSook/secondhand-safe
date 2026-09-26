import { test, expect } from "@playwright/test";
import path from "node:path";

test("landing: a real recall sample returns a recall verdict", async ({ page }) => {
  await page.goto("/");
  await page.locator("#check").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: /Harppa high chair/ }).click();
  await expect(page.getByText("VERDICT · RECALL_MATCH")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/CPSC 26061/)).toBeVisible();
});

test("landing: the model section shows numbers from the eval artifact", async ({ page, request }) => {
  const stats = await (await request.get("/api/stats")).json();
  await page.goto("/");
  await page.locator("#oracle").scrollIntoViewIfNeeded();
  await expect(page.locator("#oracle")).toContainText(stats.classifier.macroF1.toFixed(2));
});

test("pickup: the on-device model classifies a CPSC sleeper photo and a decision appears", async ({ page }) => {
  await page.goto("/pickup");
  await page.locator('input[type="file"]').setInputFiles(path.join(__dirname, "..", "fixtures", "classifier", "fx0.jpg"));
  await expect(page.getByText(/ON-DEVICE MODEL/)).toBeVisible({ timeout: 200_000 });
  await expect(page.getByText(/infant sleeper · \d+%/)).toBeVisible();
  await expect(page.getByText(/DECISION · /)).toBeVisible({ timeout: 30_000 });
});

test("judge page lists live integrations honestly", async ({ page }) => {
  await page.goto("/judge");
  await expect(page.getByRole("heading", { name: /Judges: three minutes/ })).toBeVisible();
  await expect(page.getByText("CPSC recall index + matcher")).toBeVisible();
});
