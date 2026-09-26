import { test, expect, type Page } from "@playwright/test";
import { fillCard } from "./card";

/** The table kiosk (/checkpoint): keyboard-wedge input settling a real hold through /api/pickup. */

const state = (page: Page) => page.getByTestId("kiosk-state");

test("checkpoint: with no deal attached a scan sends nothing, and a non-token is refused", async ({ page }) => {
  await page.goto("/checkpoint");
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await expect(state(page)).toHaveAttribute("data-state", "IDLE");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("012345678905", { delay: 5 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("kiosk-error")).toContainText("No deal attached");
  await page.getByLabel(/paste the deal token/).fill("not a token");
  await page.getByRole("button", { name: "Attach deal" }).click();
  await expect(page.getByTestId("kiosk-error")).toContainText("not a deal token");
  await expect(state(page)).toHaveAttribute("data-state", "IDLE");
});

/** Holds a real Visa sandbox payment on /pickup the way deal.spec.ts does; returns the deal token. */
async function holdOnPickup(page: Page, pick: number): Promise<string> {
  await page.goto("/pickup");
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await fillCard(page);
  await page.locator('input[name="listing"]').nth(pick).check();
  await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
  await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => (JSON.parse(sessionStorage.getItem("shs-deal") ?? "{}") as { token: string }).token);
}

test.describe("checkpoint settles a real Visa hold from a barcode", () => {
  test.beforeEach(async ({ request }) => {
    const h = await (await request.get("/api/health")).json();
    test.skip(!h.integrations.visa, "no Visa sandbox keys on this deployment");
  });

  test("scanner-speed UPC with no recall captures the hold held in this tab", async ({ page }) => {
    await holdOnPickup(page, 1);
    // the held amount, which a Visa card-linked offer may have discounted below the $45 list price
    const held = await page.evaluate(() => (JSON.parse(sessionStorage.getItem("shs-deal") ?? "{}") as { amountUsd: number }).amountUsd);
    await page.goto("/checkpoint");
    await expect(state(page)).toHaveAttribute("data-state", "HELD");
    await expect(page.getByTestId("kiosk-amount")).toHaveText(`$${held.toFixed(2)}`);
    await page.locator("#kiosk-upc").pressSequentially("012345678905", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect(state(page)).toHaveAttribute("data-state", "CAPTURED", { timeout: 30_000 });
    await expect(page.getByTestId("kiosk-last-scan")).toContainText("from the scanner");
    await expect(page.getByText("capture", { exact: true })).toBeVisible();
    // /pickup's copy of the same deal moved too, so it can never re-post the token
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("shs-deal") ?? "{}").status)).toBe("CAPTURED");
  });

  test("a typed recalled UPC reverses a pasted-in deal on another device", async ({ page, browser }) => {
    const token = await holdOnPickup(page, 0);
    const kiosk = await (await browser.newContext()).newPage();
    await kiosk.goto("/checkpoint");
    await expect(state(kiosk)).toHaveAttribute("data-state", "IDLE");
    await kiosk.getByLabel(/paste the deal token/).fill(token);
    await kiosk.getByRole("button", { name: "Attach deal" }).click();
    await expect(state(kiosk)).toHaveAttribute("data-state", "HELD", { timeout: 15_000 });
    await kiosk.locator("#kiosk-upc").pressSequentially("669028116546", { delay: 120 });
    await kiosk.keyboard.press("Enter");
    await expect(state(kiosk)).toHaveAttribute("data-state", "REVERSED", { timeout: 30_000 });
    await expect(kiosk.getByTestId("kiosk-last-scan")).toContainText("typed");
    await expect(kiosk.getByRole("link", { name: /CPSC 26530/ })).toBeVisible();
  });
});
