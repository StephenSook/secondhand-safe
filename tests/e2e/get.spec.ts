import { test, expect } from "@playwright/test";

test("/get/android redirects (302) to the release APK", async ({ request }) => {
  const res = await request.get("/get/android", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe("https://github.com/StephenSook/secondhand-safe/releases/download/mobile-v1.0.0/Lullabuy-1.0.0.apk");
});

test("/get/ios without a TestFlight link says so and offers the web app and the APK", async ({ page }) => {
  await page.goto("/get/ios");
  await expect(page.getByRole("heading", { name: /for iPhone is in TestFlight/ })).toBeVisible();
  await expect(page.getByText(/waiting on Apple's beta review/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open the pickup scan/ })).toHaveAttribute("href", "/pickup");
  await expect(page.getByRole("link", { name: /Get the Android APK/ })).toHaveAttribute("href", "/get/android");
});
