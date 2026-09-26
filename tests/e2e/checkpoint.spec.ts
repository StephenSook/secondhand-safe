import { test, expect, type Page, type Route } from "@playwright/test";
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

/** An UNSIGNED token with a deal token's shape: the kiosk only reads its body for display (the server verifies
 *  the signature, and nothing here is ever sent to /api/pickup). */
const fakeToken = (dealId: string, amountUsd: number) =>
  `${Buffer.from(JSON.stringify({ dealId, authId: "0", amountUsd, iat: Date.now() })).toString("base64url")}.${"x".repeat(43)}`;
const record = (dealId: string, status: string, amountUsd: number) => ({ dealId, listing: "A listing", amountUsd, status, card: null, agent: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] });

test("checkpoint: a delayed record answer for deal A never finalizes deal B attached after it", async ({ page }) => {
  const A = "shs-aaaaaaaa-0001", B = "shs-bbbbbbbb-0002";
  await page.route("**/api/stream**", (r) => r.fulfill({ status: 503, body: "{}" })); // poll, so reads are predictable
  let aCalls = 0;
  const heldA: Route[] = [];
  await page.route(`**/api/deals/${A}`, (r) => { aCalls += 1; if (aCalls === 1) return r.fulfill({ json: record(A, "HELD", 64) }); heldA.push(r); });
  await page.route(`**/api/deals/${B}`, (r) => r.fulfill({ json: record(B, "HELD", 45) }));
  await page.goto("/checkpoint");
  await page.evaluate(() => sessionStorage.removeItem("shs-deal"));
  await page.reload();
  await page.getByLabel(/paste the deal token/).fill(fakeToken(A, 64));
  await page.getByRole("button", { name: "Attach deal" }).click();
  await expect(state(page)).toHaveAttribute("data-state", "HELD");
  await expect.poll(() => heldA.length).toBeGreaterThan(0); // A's record read is now stalled
  await page.getByRole("button", { name: "Detach this deal from the kiosk" }).click();
  await page.getByLabel(/paste the deal token/).fill(fakeToken(B, 45));
  await page.getByRole("button", { name: "Attach deal" }).click();
  await expect(page.getByTestId("kiosk-amount")).toHaveText("$45.00");
  // A's stalled read finally answers CAPTURED
  for (const r of heldA) await r.fulfill({ json: record(A, "CAPTURED", 64) }).catch(() => {});
  await page.waitForTimeout(1500);
  await expect(state(page)).toHaveAttribute("data-state", "HELD");
  await expect(page.getByText(B, { exact: true })).toBeVisible();
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

  test("two devices settling one hold at once: one Visa call, both get the same answer, a repeat is replayed", async ({ page, request }) => {
    const token = await holdOnPickup(page, 1);
    const [a, b] = await Promise.all([
      request.post("/api/pickup", { data: { token, upc: "012345678905" } }), // clean: would capture
      request.post("/api/pickup", { data: { token, upc: "669028116546" } }), // recalled: would reverse
    ]);
    const ja = await a.json(), jb = await b.json();
    expect([a.status(), b.status()].every((s) => s === 200 || s === 409), `${a.status()} ${b.status()}`).toBe(true);
    const answered = [ja, jb].filter((j) => j.status);
    // exactly one of them settled at Visa; the other replayed that answer or was told it is being settled
    expect(answered.filter((j) => !j.replayed)).toHaveLength(1);
    const winner = answered.find((j) => !j.replayed);
    expect(["CAPTURED", "REVERSED"]).toContain(winner.status);
    for (const j of [ja, jb]) if (j.replayed) expect(j.status).toBe(winner.status);
    for (const j of [ja, jb]) if (!j.status) expect(j).toMatchObject({ settling: true, visaCalled: false });
    const again = await (await request.post("/api/pickup", { data: { token, upc: "669028116546" } })).json();
    expect(again).toMatchObject({ replayed: true, status: winner.status });
    expect(again.visa?.id).toBe(winner.visa?.id);
  });
});
