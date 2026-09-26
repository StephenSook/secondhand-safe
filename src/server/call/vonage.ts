import { randomUUID, sign } from "node:crypto";
import type { NccoAction } from "./ncco";

/**
 * Vonage Voice API, called directly (no SDK): an RS256 application JWT and POST /v1/calls with an inline NCCO.
 * The call uses its own Vonage application (lullabuy-recall-call); `from` is a number the account owns, which
 * Vonage accepts as caller id without linking it to this application (linking only routes INBOUND calls).
 */
const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function vonageJwt(applicationId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ application_id: applicationId, iat, exp: iat + 300, jti: randomUUID() }));
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKeyPem);
  return `${head}.${body}.${b64u(sig)}`;
}

export type PlaceResult = { ok: true; uuid: string } | { ok: false; error: string };

/** Places one outbound call. Never throws; gives up after `timeoutMs` even if the fetch ignores its abort signal. */
export async function placeCall(
  o: { applicationId: string; privateKey: string; to: string; from: string; ncco: NccoAction[]; eventUrl: string },
  fetchImpl: typeof fetch = fetch, timeoutMs = 10_000,
): Promise<PlaceResult> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PlaceResult>((ok) => { timer = setTimeout(() => { ctl.abort(); ok({ ok: false, error: `Vonage did not answer in ${timeoutMs} ms` }); }, timeoutMs); });
  const attempt = (async (): Promise<PlaceResult> => {
    let jwt: string;
    try { jwt = vonageJwt(o.applicationId, o.privateKey); } catch (e) { return { ok: false, error: `could not sign the Vonage JWT: ${(e as Error).message}` }; }
    const res = await fetchImpl("https://api.nexmo.com/v1/calls", {
      method: "POST", signal: ctl.signal,
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        to: [{ type: "phone", number: o.to.replace(/^\+/, "") }],
        from: { type: "phone", number: o.from.replace(/^\+/, "") },
        ncco: o.ncco, event_url: [o.eventUrl], event_method: "POST",
        ringing_timer: 45, length_timer: 180,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Vonage HTTP ${res.status}: ${text.slice(0, 160)}` };
    try {
      const j = JSON.parse(text) as { uuid?: unknown };
      return typeof j.uuid === "string" ? { ok: true, uuid: j.uuid } : { ok: false, error: "Vonage answered without a call uuid" };
    } catch {
      return { ok: false, error: "Vonage answered with a body that was not JSON" };
    }
  })().catch((e: unknown) => ({ ok: false as const, error: `Vonage request failed: ${(e as Error).message}` }));
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
