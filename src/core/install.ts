/**
 * Stable first-party install links (printed as QR codes in the demo film), so the target can change without
 * reprinting a code: /get/android and /get/ios.
 */
export const ANDROID_APK_URL = "https://github.com/StephenSook/secondhand-safe/releases/download/mobile-v1.0.0/Lullabuy-1.0.0.apk";
export const ANDROID_PATH = "/get/android";
export const IOS_PATH = "/get/ios";

/**
 * The public TestFlight invite link, or null. Only an https link on testflight.apple.com counts, so a typo in the
 * env var can never send a phone that scanned our QR code to some other site.
 */
export function testflightUrl(src: Record<string, string | undefined> = process.env): string | null {
  const raw = src.TESTFLIGHT_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "testflight.apple.com" ? u.toString() : null;
  } catch {
    return null;
  }
}
