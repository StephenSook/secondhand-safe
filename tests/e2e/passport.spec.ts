import { test, expect } from "@playwright/test";
import { fillCard } from "./card";

/** A clean label captures the hold, writes a Solana devnet passport, and the passport page verifies it. */
test("capture writes a passport a stranger can verify", async ({ page, request }) => {
  const h = await (await request.get("/api/health")).json();
  test.skip(!(h.integrations.visa && h.integrations.solana), "needs Visa sandbox keys and a funded Solana devnet key");
  await page.goto("/pickup");
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await fillCard(page);
  await page.locator('input[name="listing"]').nth(1).check();
  await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("model").fill("ZZT9Q41X");
  await page.getByRole("button", { name: /Check what the label says/ }).click();
  await expect(page.getByText("CAPTURED", { exact: true })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("link", { name: "Solana devnet record" }).click();
  await expect(page.getByText(/Verified: our signer/)).toBeVisible({ timeout: 45_000 });
});
