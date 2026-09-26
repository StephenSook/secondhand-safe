import metrics from "../../ml/out/metrics.json";
import labels from "../../ml/out/split.json";
import { INDEX_SIZE } from "@/server/recalls/match";
import { Preloader } from "@/ui/Preloader";
import { Nav } from "@/ui/Nav";
import { Hero } from "@/ui/Hero";
import { Problem } from "@/ui/Problem";
import { Ribbons } from "@/ui/Ribbons";
import { HowItWorks } from "@/ui/HowItWorks";
import { ScrollScan } from "@/ui/ScrollScan";
import { LiveCheck } from "@/ui/LiveCheck";
import { Oracle, type OracleData } from "@/ui/Oracle";
import { Footer } from "@/ui/Footer";

type M = {
  held_out_n: number; train_n: number;
  systems: Record<string, { macro_f1: number; macro_f1_ci95: number[];
    per_class: OracleData["perClass"]; confusion: number[][] }>;
};

/** Harvest counts are fixed facts of the committed dataset (ml/labels.csv provenance, see PLAN 1.6). */
const HARVEST = { listings: 1662, cpscPhotos: 243 };

export default function Home() {
  const m = metrics as unknown as M;
  const head = m.systems.clip_head;
  const zs = m.systems.zero_shot;
  const split = labels as unknown as { train: string[]; held_out: string[] };
  const oracle: OracleData = {
    heldOut: m.held_out_n,
    train: m.train_n,
    macroF1: head.macro_f1,
    ci: head.macro_f1_ci95,
    zeroShotF1: zs.macro_f1,
    falseTrained: head.confusion[3].slice(0, 3).reduce((a, b) => a + b, 0),
    falseZero: zs.confusion[3].slice(0, 3).reduce((a, b) => a + b, 0),
    ordinaryN: head.confusion[3].reduce((a, b) => a + b, 0),
    perClass: head.per_class,
    confusion: head.confusion,
    listings: HARVEST.listings,
    cpscPhotos: HARVEST.cpscPhotos,
    labels: split.train.length + split.held_out.length,
  };
  return (
    <>
      <Preloader />
      <Nav />
      <main>
        <Hero recalls={INDEX_SIZE.recalls} />
        <Problem />
        <Ribbons />
        <HowItWorks />
        <ScrollScan />
        <LiveCheck />
        <Oracle d={oracle} />
      </main>
      <Footer />
    </>
  );
}
