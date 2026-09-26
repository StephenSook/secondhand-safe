import { test, expect } from "@playwright/test";

/** The shopping agent end to end: a request returns real pre-screened listings; an agent buy places a Visa hold
 *  that the pickup page then shows. The hold needs Visa + TAP keys (skipped with the reason otherwise). */
test("request -> pre-screened real listings -> agent hold -> pickup", async ({ page, request }) => {
  await page.goto("/shop");
  await page.getByLabel("TELL THE AGENT WHAT YOU NEED").fill("baby crib under $150");
  await page.getByRole("button", { name: /Find it/ }).click();
  await expect(page.getByText(/real listings, each pre-screened/)).toBeVisible({ timeout: 45_000 });
  const cards = page.locator("li[data-tone]");
  expect(await cards.count()).toBeGreaterThan(0);
  const h = await (await request.get("/api/health")).json();
  test.skip(!(h.integrations.visa && h.integrations.tap), "no Visa or TAP keys on this deployment");
  const buy = page.getByRole("button", { name: /Buy with our agent: hold \$/ }).first();
  await expect(buy).toBeVisible();
  await buy.click();
  await expect(page.getByText(/HELD \$\d+\.\d\d at Visa/)).toBeVisible({ timeout: 45_000 });
  await page.getByRole("link", { name: /open the pickup scan/ }).click();
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
});
