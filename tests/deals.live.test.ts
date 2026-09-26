import { it, expect } from "vitest";
import { recordHold, recordSettlement, getDeal } from "@/server/deals/store";
import { getDb } from "@/server/db/mongo";

/** Round trip against the real Atlas cluster, in a throwaway database that is dropped afterwards. */
it.skipIf(!process.env.MONGODB_URI)("hold, settle, a later scan cannot un-finalize, then read back", async () => {
  process.env.MONGODB_DB = `lullabuy_test_${Date.now()}`;
  const id = `shs-test-${Date.now().toString(16)}`;
  expect(await recordHold({ dealId: id, listing: "Harppa high chair", amountUsd: 64, card: "microform", agent: null })).toBe(true);
  expect(await recordSettlement(id, { status: "REVERSED", verdict: { kind: "RECALL_MATCH", reason: "CPSC 26-061", recall: "26061" } })).toBe(true);
  expect(await recordSettlement(id, { status: "HELD", verdict: { kind: "NEEDS_CHECK", reason: "rescan" } })).toBe(true);
  const r = await getDeal(id);
  expect(r.state).toBe("ok");
  const d = r.state === "ok" ? r.deal : null;
  expect(d?.status).toBe("REVERSED");
  expect(d?.verdict?.reason).toBe("CPSC 26-061"); // the rescan's reason does not overwrite the final one
  expect(d?.events.map((e) => e.status)).toEqual(["HELD", "REVERSED", "HELD"]);
  expect(await getDeal("shs-nosuchdeal-0000")).toEqual({ state: "missing" });
  expect(await recordSettlement("shs-nosuchdeal-0000", { status: "CAPTURED", verdict: { kind: "NO_MATCH", reason: "x" } })).toBe(false);
  await (await getDb())!.dropDatabase();
}, 60_000);
