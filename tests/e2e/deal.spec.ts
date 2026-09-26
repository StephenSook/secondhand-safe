import { test, expect } from "@playwright/test";

/**
 * The money loop in a browser, against the real Visa Acceptance sandbox. Runs only where the deployment has
 * Visa keys (reported by /api/health); elsewhere it is skipped with that reason, never silently passed.
 */
test.describe("Visa hold settles on the pickup check", () => {
  test.beforeEach(async ({ request }) => {
    const h = await (await request.get("/api/health")).json();
    test.skip(!h.integrations.visa, "no Visa sandbox keys on this deployment");
  });

  for (const c of [
    { name: "recalled label reverses the hold", pick: 0, model: "BHC001", batch: "202408", want: "REVERSED" },
    { name: "clean label captures the hold", pick: 1, model: "ZZT9Q41X", batch: "", want: "CAPTURED" },
  ]) {
    test(c.name, async ({ page }) => {
      await page.goto("/pickup");
      await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
      await page.reload();
      await page.locator('input[name="listing"]').nth(c.pick).check();
      await page.getByRole("button", { name: /Agree and hold the payment/ }).click();
      await expect(page.getByText("HELD", { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel("model").fill(c.model);
      if (c.batch) await page.getByLabel("batch").fill(c.batch);
      await page.getByRole("button", { name: /Check what the label says/ }).click();
      await expect(page.getByText(c.want, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(c.want === "CAPTURED" ? "capture" : "reversal", { exact: true })).toBeVisible();
    });
  }
});
