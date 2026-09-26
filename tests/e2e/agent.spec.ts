import { test, expect } from "@playwright/test";

/** Trusted Agent Protocol end to end: a signed agent checkout is held; an edited one is refused before Visa. */
test.describe("agent checkout with Trusted Agent Protocol", () => {
  test.beforeEach(async ({ request }) => {
    const h = await (await request.get("/api/health")).json();
    test.skip(!h.integrations.visa || !h.integrations.tap, "needs Visa sandbox keys and a TAP agent key on this deployment");
  });

  test("signed agent request is verified and held; tampered request is refused", async ({ page, request }) => {
    const dir = await (await request.get("/.well-known/http-message-signatures-directory")).json();
    expect(dir.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    await page.goto("/pickup");
    await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
    await page.reload();
    await page.getByRole("button", { name: /Try a tampered agent request/ }).click();
    await expect(page.getByText(/TAP refused\..*digest/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Let our agent buy it/ }).click();
    await expect(page.getByText(/TAP verified\./)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("HELD", { exact: true })).toBeVisible();
  });
});
