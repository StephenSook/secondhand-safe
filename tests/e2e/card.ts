import { expect, type Page } from "@playwright/test";

/** Types Visa's published sandbox test card into the Microform iframes (the fields are Visa's, not ours). */
export async function fillCard(page: Page) {
  await expect(page.getByText(/These two boxes are Visa's/)).toBeVisible({ timeout: 30_000 });
  await page.frameLocator('[data-testid="mf-number"] iframe').getByRole("textbox", { name: "Card number" }).fill("4111111111111111");
  await page.frameLocator('[data-testid="mf-cvv"] iframe').getByRole("textbox", { name: "Card security code" }).fill("123");
  await page.getByLabel("expiry month").fill("12");
  await page.getByLabel("expiry year").fill("2031");
}
