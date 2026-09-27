/** A deal id as minted at checkout (src/server/visa/acceptance.ts newDealId). */
export const DEAL_ID_RE = /^shs-[0-9a-f-]{8,24}$/;

/** The Core asset's off-chain metadata JSON (its `uri`), built from the deal id alone. The on-chain Attributes plugin
 *  is the record that matters; this only gives wallets and explorers a name, a picture and a link back. */
export function passportMeta(id: string, base: string) {
  const root = base.replace(/\/+$/, "");
  return {
    name: `Lullabuy passport ${id}`,
    description: "Item passport for a secondhand baby-gear sale on Lullabuy. The on-chain attributes hold the pickup check's verdict, "
      + "the SHA-256 of its record and the recall index date; the status changes if a recall is announced after the sale. "
      + "It proves what the check said at the time of sale, not that the item is free of every hazard.",
    image: `${root}/icons/icon-512.png`,
    external_url: `${root}/deal/${id}`,
    properties: { category: "image", files: [{ uri: `${root}/icons/icon-512.png`, type: "image/png" }] },
  };
}
