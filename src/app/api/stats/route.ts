import recallStats from "../../../../data/recall_stats.json";
import metrics from "../../../../ml/out/metrics.json";
import { INDEX_SIZE, INDEX_AS_OF } from "@/server/recalls/match";

/** Public numbers, read from the artifacts the pipelines wrote. Nothing here is typed by hand. */
export async function GET() {
  const m = metrics as {
    asOf: string; held_out_n: number; train_n: number;
    systems: Record<string, { macro_f1: number; macro_f1_ci95: number[]; accuracy: number;
      per_class: Record<string, { precision: number; recall: number; f1: number; n: number }>; confusion: number[][] }>;
  };
  const other = m.systems.clip_head.confusion[3];
  const otherZs = m.systems.zero_shot.confusion[3];
  return Response.json(
    {
      recallIndex: { ...INDEX_SIZE, asOf: INDEX_AS_OF, source: "CPSC recall API",
        fetched: recallStats.recallsFetched, nurseryRecalls: recallStats.nurseryRecalls,
        withAnyIdentifier: recallStats.withAnyIdentifier, identifiers: recallStats.identifiers },
      classifier: {
        asOf: m.asOf, heldOut: m.held_out_n, train: m.train_n,
        macroF1: m.systems.clip_head.macro_f1, macroF1Ci95: m.systems.clip_head.macro_f1_ci95,
        zeroShotMacroF1: m.systems.zero_shot.macro_f1,
        falseAlarmsOnOrdinaryItems: { trained: other.slice(0, 3).reduce((a, b) => a + b, 0),
          zeroShot: otherZs.slice(0, 3).reduce((a, b) => a + b, 0), of: other.reduce((a, b) => a + b, 0) },
        perClass: m.systems.clip_head.per_class,
      },
    },
    { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } },
  );
}
