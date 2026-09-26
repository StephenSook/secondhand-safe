import { describe, it, expect } from "vitest";
import { recallCallConfig } from "@/server/call/config";
import { buildNcco, callScript } from "@/server/call/ncco";
import { parseUsPhone } from "@/server/call/phone";
import { codeNcco } from "@/server/call/verify";
import { placeCall, vonageJwt } from "@/server/call/vonage";

/**
 * ONE real outbound call per run, through the lullabuy-recall-call Vonage application. Skips unless the recall-call
 * env is complete, LIVE_CALL_TO names a phone whose owner agreed to take it, and LIVE_CALL_STEP picks the call:
 *   code   -> the verification call ("Your Lullabuy code is 4, 7, 2, 1 ...")
 *   recall -> the recall verdict, Vonage talk (the ElevenLabs stream path needs the deployed audio route)
 * It then reads the call back from Vonage (GET /v1/calls/{uuid}) until it ends, and prints the status, never the number.
 */
const cfg = recallCallConfig();
const to = parseUsPhone(process.env.LIVE_CALL_TO);
const step = process.env.LIVE_CALL_STEP;

async function follow(uuid: string): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {};
  for (let i = 0; i < 18; i++) {
    const r = await fetch(`https://api.nexmo.com/v1/calls/${uuid}`, { headers: { authorization: `Bearer ${vonageJwt(cfg!.applicationId, cfg!.privateKey)}` } });
    last = (await r.json()) as Record<string, unknown>;
    if (["completed", "failed", "rejected", "busy", "cancelled", "timeout", "unanswered"].includes(String(last.status))) break;
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  return last;
}

describe.skipIf(!cfg || !to || (step !== "code" && step !== "recall"))("recall call (live Vonage)", () => {
  it(`places the ${step} call from the owned number and Vonage completes it`, async () => {
    const ncco = step === "code"
      ? codeNcco("4721")
      : buildNcco({ text: callScript({ kind: "reversed", verdict: "RECALL_MATCH", recallNumber: "26-061" }, { listing: "", amountUsd: 42 }), audioUrl: null, inputUrl: null, replays: 0 });
    const r = await placeCall({ applicationId: cfg!.applicationId, privateKey: cfg!.privateKey, to: to!, from: cfg!.from, ncco, eventUrl: `${cfg!.baseUrl}/api/recall-call/event` });
    console.log(`[live] ${step} call to ...${to!.slice(-4)}: ${JSON.stringify(r)}`);
    expect(r).toMatchObject({ ok: true });
    const c = await follow((r as { uuid: string }).uuid);
    console.log(`[live] vonage says: status=${c.status} duration=${c.duration ?? "?"} price=${c.price ?? "?"} network=${c.network ?? "?"} direction=${c.direction}`);
    expect(c.status).toBe("completed");
  }, 120_000);
});
