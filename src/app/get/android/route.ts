import { ANDROID_APK_URL } from "@/core/install";

/** GET /get/android: 302 to the signed Android APK on the mobile-v1.0.0 GitHub release. */
export function GET() {
  return new Response(null, { status: 302, headers: { location: ANDROID_APK_URL, "cache-control": "no-store" } });
}
