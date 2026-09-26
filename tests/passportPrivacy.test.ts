import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// the real pickup route with Visa, Solana, Atlas and the matcher mocked: what ends up in the PUBLIC passport link
const VISA_CAPTURE = "7300000000000000000001";
const AUTH_ID = "7200000000000000000999";
vi.mock("@/server/visa/creds", () => ({ visaCreds: () => ({ secret: "test-secret" }) }));
vi.mock("@/server/deals/token", () => ({ verifyDealToken: () => ({ dealId: "shs-0123abcd-4567", authId: AUTH_ID, amountUsd: 40, iat: 1 }) }));
vi.mock("@/server/deals/settle", () => ({ settle: vi.fn(async () => ({ status: "CAPTURED", visa: { id: VISA_CAPTURE, status: "PENDING", httpStatus: 201 } })) }));
vi.mock("@/server/recalls/match", () => ({ checkLabel: () => ({ kind: "NO_MATCH", reason: "no recall names this model", asOf: "2026-09-20" }) }));
vi.mock("@/server/solana/memo", async (orig) => ({ ...(await orig<typeof import("@/server/solana/memo")>()), anchor: vi.fn(async () => "5".repeat(88)) }));
vi.mock("@/server/deals/store", async (orig) => ({ ...(await orig<typeof import("@/server/deals/store")>()), recordSettlement: vi.fn(async () => true) }));
vi.mock("@/server/solana/mints", () => ({ mintPassport: vi.fn(async () => ({ state: "minted" })) }));
vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { void p; } }));
import { POST } from "@/app/api/pickup/route";
import { boardDeal, pub, recordSettlement, type DealRecord } from "@/server/deals/store";

/** every Visa-looking thing a decoded public record could carry: a key naming Visa, auth or capture, a known id, or a
 *  long digit run (Visa transaction ids are 22 digits) */
function visaLeaks(recordJson: string, known: string[]): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) { if (/visa|auth|capture/i.test(k)) hits.push(`key ${path}${k}`); walk(x, `${path}${k}.`); } }
    else if (typeof v === "string" && (known.includes(v) || /\d{16,}/.test(v))) hits.push(`value ${path}`);
  };
  walk(JSON.parse(recordJson), "");
  for (const k of known) if (recordJson.includes(k)) hits.push(`text ${k}`);
  return hits;
}
const decode = (path: string) => Buffer.from(new URL(path, "https://x.test").searchParams.get("r") ?? "", "base64url").toString("utf8");

beforeEach(() => { vi.stubEnv("SOLANA_SECRET_KEY_B58", "set-for-this-test"); vi.stubEnv("PUBLIC_BASE_URL", "https://example.test"); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("the public passport record carries no Visa identifier", () => {
  it("the leak check itself catches the old record shape (positive control)", () => {
    const old = JSON.stringify({ v: 1, dealId: "shs-0123abcd-4567", visaCapture: VISA_CAPTURE, at: "t" });
    expect(visaLeaks(old, [VISA_CAPTURE, AUTH_ID]).length).toBeGreaterThan(0);
  });
  it("every public passportPath shape (the pickup response, the stored deal, the public deal, the board) decodes clean", async () => {
    const res = await POST(new Request("https://example.test/api/pickup", { method: "POST", body: JSON.stringify({ token: "t", model: "M1" }) }));
    const j = await res.json();
    expect(j.status).toBe("CAPTURED");
    expect(j.visa.id).toBe(VISA_CAPTURE); // the buyer holding the deal token still gets the capture id in the response
    const stored = vi.mocked(recordSettlement).mock.calls[0][1].passportPath as string;
    const d: DealRecord = { _id: "shs-0123abcd-4567", listing: "x", amountUsd: 40, status: "CAPTURED", card: null, agent: null, authId: AUTH_ID,
      createdAt: "t", updatedAt: "t", events: [], passportPath: stored };
    const shapes = [j.passport.path as string, stored, pub(d).passportPath as string, boardDeal(d).passportPath as string];
    for (const path of shapes) {
      const rec = decode(path);
      expect(JSON.parse(rec)).toMatchObject({ v: 1, dealId: "shs-0123abcd-4567", verdict: "NO_MATCH" });
      expect(visaLeaks(rec, [VISA_CAPTURE, AUTH_ID]), path).toEqual([]);
    }
    expect(JSON.stringify(pub(d))).not.toContain(AUTH_ID);
    expect(JSON.stringify(boardDeal(d))).not.toContain(AUTH_ID);
  });
});
