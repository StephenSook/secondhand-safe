import { describe, it, expect } from "vitest";
import { ANDROID_APK_URL, testflightUrl } from "@/core/install";
import { GET } from "@/app/get/android/route";

describe("/get/android", () => {
  it("302s to the APK asset on the mobile-v1.0.0 release", () => {
    const res = GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(ANDROID_APK_URL);
    expect(ANDROID_APK_URL).toBe("https://github.com/StephenSook/secondhand-safe/releases/download/mobile-v1.0.0/Lullabuy-1.0.0.apk");
  });
});

describe("/get/ios TestFlight target", () => {
  it("is null when unset or blank, so the page shows the honest status", () => {
    expect(testflightUrl({})).toBeNull();
    expect(testflightUrl({ TESTFLIGHT_PUBLIC_URL: "  " })).toBeNull();
  });
  it("accepts only an https link on testflight.apple.com", () => {
    expect(testflightUrl({ TESTFLIGHT_PUBLIC_URL: " https://testflight.apple.com/join/AbC123 " })).toBe("https://testflight.apple.com/join/AbC123");
    expect(testflightUrl({ TESTFLIGHT_PUBLIC_URL: "http://testflight.apple.com/join/AbC123" })).toBeNull();
    expect(testflightUrl({ TESTFLIGHT_PUBLIC_URL: "https://testflight.apple.com.evil.example/join/x" })).toBeNull();
    expect(testflightUrl({ TESTFLIGHT_PUBLIC_URL: "not a url" })).toBeNull();
  });
});
