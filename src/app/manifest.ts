import type { MetadataRoute } from "next";
import { BRAND, TAGLINE } from "@/core/brand";

/** Installable on a phone's home screen: the pickup scan opens full screen, like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND,
    short_name: BRAND,
    description: TAGLINE,
    start_url: "/pickup",
    display: "standalone",
    background_color: "#fff8ec",
    theme_color: "#ffb020",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Shop with the agent", url: "/shop" },
      { name: "Pickup scan", url: "/pickup" },
    ],
  };
}
