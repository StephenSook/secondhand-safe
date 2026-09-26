import { test, expect } from "@playwright/test";

/** Microform card entry against the real Visa sandbox: the card goes into Visa's iframes and comes back as a
 *  transient token, which /api/checkout authorizes in place of a card. Skipped (with reason) without Visa keys. */
test("a card typed into Visa's Microform fields is held", async ({ page, request }) => {
  const h = await (await request.get("/api/health")).json();
  test.skip(!h.integrations.visa, "no Visa sandbox keys on this deployment");
  await page.goto("/pickup");
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await expect(page.getByText(/These two boxes are Visa's/)).toBeVisible({ timeout: 30_000 });
  await page.frameLocator('[data-testid="mf-number"] iframe').getByRole("textbox", { name: "Card number" }).fill("4111111111111111");
  await page.frameLocator('[data-testid="mf-cvv"] iframe').getByRole("textbox", { name: "Card security code" }).fill("123");
  await page.locator('input[name="listing"]').nth(1).check();
  const resp = page.waitForResponse((r) => r.url().endsWith("/api/checkout"));
  await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
  const body = await (await resp).json();
  expect(body.card, JSON.stringify(body)).toBe("microform");
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
});
