import { describe, it, expect } from "vitest";
import { recallCallConfig } from "@/server/call/config";
import { buildNcco, callScript } from "@/server/call/ncco";
import { parseUsPhone } from "@/server/call/phone";
import { placeCall } from "@/server/call/vonage";

/**
 * One REAL outbound call through the lullabuy-recall-call Vonage application. Skips unless the recall-call env is
 * complete AND LIVE_CALL_TO names the phone to ring (a person who agreed to take it). Uses Vonage talk, so it needs
 * no deployed audio route; the deployed stream path is proved by placing a call from /pickup.
 */
const cfg = recallCallConfig();
const to = parseUsPhone(process.env.LIVE_CALL_TO);

describe.skipIf(!cfg || !to)("recall call (live Vonage)", () => {
  it("Vonage accepts the call from the owned number and returns a call uuid", async () => {
    const text = callScript({ kind: "reversed", verdict: "RECALL_MATCH", recallNumber: "26-061" }, { listing: "", amountUsd: 42 });
    const r = await placeCall({ applicationId: cfg!.applicationId, privateKey: cfg!.privateKey, to: to!, from: cfg!.from,
      ncco: buildNcco({ text, audioUrl: null, inputUrl: null, replays: 0 }), eventUrl: `${cfg!.baseUrl}/api/recall-call/event` });
    expect(r).toMatchObject({ ok: true });
  }, 30_000);
});
