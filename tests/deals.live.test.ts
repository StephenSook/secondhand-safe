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
  const d = await getDeal(id);
  expect(d?.status).toBe("REVERSED");
  expect(d?.events.map((e) => e.status)).toEqual(["HELD", "REVERSED", "HELD"]);
  await (await getDb())!.dropDatabase();
}, 60_000);
