"""Compose docs/FACTS.json (PLAN contract) from the pipeline artifacts. The README, /judge, the video and the
Devpost writeup read numbers from that file; nothing in it is typed by hand.

  ml/.venv/bin/python ml/facts.py
"""
import csv
import datetime
import glob
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def fine_tune():
    """The deep fine-tune (ml/finetune.py) on the same held-out split. Reported as an experiment, not shipped."""
    p = os.path.join(HERE, "out", "finetune_b2.json")
    if not os.path.exists(p):
        return None
    f = json.load(open(p))
    c = f["confusion"]
    return {"what": f["what"], "macroF1": f["macro_f1"], "macroF1Ci95": f["macro_f1_ci95"],
            "falseAlarmsOnOrdinary": sum(c[3][:3]), "ordinaryHeldOut": sum(c[3]), "shipped": False,
            "why": "within the confidence interval of the shipped head; shipping it would mean a custom 90 MB model on the phone"}


def main():
    metrics = json.load(open(os.path.join(HERE, "out", "metrics.json")))
    stats = json.load(open(os.path.join(ROOT, "data", "recall_stats.json")))
    scan = json.load(open(os.path.join(HERE, "out", "scan.json")))["rows"]
    labels = list(csv.DictReader(open(os.path.join(HERE, "labels.csv"))))
    rounds = []
    for p in sorted(glob.glob(os.path.join(HERE, "review_rounds", "round-*.csv"))):
        rows = list(csv.DictReader(open(p)))
        c = Counter(r["ok"] for r in rows)
        rounds.append({"round": os.path.basename(p)[6:8], "flags": len(rows), "confirmed": c["yes"],
                       "unsure": c["unsure"], "falseAlarms": c["no"], "unreviewed": c[""]})
    if any(r["unreviewed"] for r in rounds):
        raise SystemExit("a review round has unreviewed flags; review them before publishing numbers")
    head = metrics["systems"]["clip_head"]
    zs = metrics["systems"]["zero_shot"]
    ordinary = head["confusion"][3]
    facts = {
        "asOf": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "scanned": len(scan),
        "scannedBySource": dict(Counter(r["source"] for r in scan)),
        "scannedAtlanta": sum(1 for r in scan if r["region"] == "atlanta"),
        "flagged": rounds[-1]["flags"] if rounds else None,
        "precisionReviewed": (rounds[-1]["confirmed"] / rounds[-1]["flags"]) if rounds and rounds[-1]["flags"] else None,
        "scanRounds": rounds,
        "hardNegativesFromScan": sum(1 for r in labels if r["reviewed_by"].startswith("scan review")),
        "classifier": {
            "macroF1": head["macro_f1"], "macroF1Ci95": head["macro_f1_ci95"], "zeroShotMacroF1": zs["macro_f1"],
            "heldOut": metrics["held_out_n"],
            "falseAlarmsOnOrdinary": sum(ordinary[:3]), "falseAlarmsZeroShot": sum(zs["confusion"][3][:3]),
            "ordinaryHeldOut": sum(ordinary),
            "embeddings": metrics["train_info"]["clip"].get("embeddings"),
        },
        "fineTuneExperiment": fine_tune(),
        "recallIndex": {k: stats.get(k) for k in ("recallsFetched", "nurseryRecalls", "nhtsaChildSeatCampaigns", "withAnyIdentifier", "identifiers")},
    }
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    json.dump(facts, open(os.path.join(ROOT, "docs", "FACTS.json"), "w"), indent=1)
    print(json.dumps(facts, indent=1))


if __name__ == "__main__":
    main()
