import { test, expect } from "@playwright/test";
import { fillCard } from "./card";

/** Two phones at the curb: the buyer holds and scans, the seller's view (MongoDB Atlas) follows the same deal. */
test("the seller's live view follows the hold and the reversal", async ({ page, context, request }) => {
  const h = await (await request.get("/api/health")).json();
  test.skip(!(h.integrations.visa && h.integrations.mongo), "needs Visa sandbox keys and MongoDB Atlas on this deployment");
  await page.goto("/pickup");
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await fillCard(page);
  await page.locator('input[name="listing"]').nth(0).check();
  await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
  const href = await page.getByRole("link", { name: "open the seller view" }).getAttribute("href");
  const seller = await context.newPage();
  await seller.goto(href!);
  await expect(seller.getByText("Held at Visa")).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("model").fill("BHC001");
  await page.getByLabel("batch").fill("202408");
  await page.getByRole("button", { name: /Check what the label says/ }).click();
  await expect(page.getByText("REVERSED", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(seller.getByText(/Reversed: buyer keeps the money/)).toBeVisible({ timeout: 15_000 });
  await expect(seller.getByText(/26-061/).first()).toBeVisible();
});
