import type { Metadata } from "next";
import { Checkpoint } from "@/ui/Checkpoint";
import { BRAND } from "@/core/brand";

export const metadata: Metadata = { title: `Pickup checkpoint: ${BRAND}` };

/** The table kiosk at the pickup: full screen, one deal, a barcode scanner or a keyboard as input. */
export default function CheckpointPage() {
  return <Checkpoint />;
}
