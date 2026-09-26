import QRCode from "qrcode";

/** GET /api/qr?deal=<dealId>: an SVG QR code for this deployment's seller view of that deal (nothing else). */
export async function GET(request: Request) {
  const u = new URL(request.url);
  const deal = u.searchParams.get("deal") ?? "";
  if (!/^shs-[0-9a-f-]{8,24}$/.test(deal)) return new Response("bad deal id", { status: 400 });
  const svg = await QRCode.toString(`${u.origin}/deal/${deal}`, { type: "svg", margin: 1, color: { dark: "#14163a", light: "#ffffff" } });
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
}
