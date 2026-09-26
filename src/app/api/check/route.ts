import { checkLabel } from "@/server/recalls/match";
import type { ProductClass } from "@/core/verdict";

/**
 * Public recall check. Anyone can run it, no key:
 *   curl "https://<host>/api/check?model=BHC001&batch=202408"
 * Query: model, batch, upc, text (free label text), cls + p (classifier output).
 */
const CLASSES: ProductClass[] = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"];

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const get = (k: string) => q.get(k)?.slice(0, 200) || undefined;
  const clsName = get("cls") as ProductClass | undefined;
  const p = Number(get("p") ?? "");
  if (clsName && !CLASSES.includes(clsName)) {
    return Response.json({ error: `cls must be one of ${CLASSES.join(", ")}` }, { status: 400 });
  }
  const t0 = performance.now();
  const verdict = checkLabel({
    model: get("model"),
    batch: get("batch"),
    upc: get("upc"),
    text: get("text"),
    cls: clsName && Number.isFinite(p) ? { cls: clsName, p } : undefined,
  });
  return Response.json(
    { verdict, ms: Math.round((performance.now() - t0) * 100) / 100 },
    { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "JSON body required" }, { status: 400 });
  const b = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
  const cls = b.cls as { cls?: string; p?: number } | undefined;
  const verdict = checkLabel({
    model: str(b.model), batch: str(b.batch), upc: str(b.upc), text: str(b.text),
    cls: cls && CLASSES.includes(cls.cls as ProductClass) && typeof cls.p === "number"
      ? { cls: cls.cls as ProductClass, p: cls.p } : undefined,
  });
  return Response.json({ verdict }, { headers: { "cache-control": "no-store" } });
}
