import { test, expect } from "@playwright/test";
import { fillCard } from "./card";

/** Visa Token Management Service: save the card on the first hold, pay the second with the saved card. */
test("a saved card pays the next hold without re-entering it", async ({ page, request }) => {
  const h = await (await request.get("/api/health")).json();
  test.skip(!h.integrations.visa, "no Visa sandbox keys on this deployment");
  await page.goto("/pickup");
  await page.evaluate(() => { sessionStorage.removeItem("shs-deal"); localStorage.removeItem("lullabuy-saved-card"); });
  await page.reload();
  await fillCard(page);
  await page.getByLabel(/Save this card with Visa/).check();
  await page.locator('input[name="listing"]').nth(1).check();
  const first = page.waitForResponse((r) => r.url().endsWith("/api/checkout"));
  await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
  const a = await (await first).json();
  expect(a.card, JSON.stringify(a)).toBe("microform");
  expect(typeof a.savedCard).toBe("string");
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await expect(page.getByText(/Use my saved card/)).toBeVisible({ timeout: 15_000 });
  await page.locator('input[name="listing"]').nth(1).check();
  const second = page.waitForResponse((r) => r.url().endsWith("/api/checkout"));
  await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
  const b = await (await second).json();
  expect(b.card, JSON.stringify(b)).toBe("saved-card");
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
});
