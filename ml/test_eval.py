"""Checks on the trained classifier. They need the local run artifacts (ml/out, ml/labels.csv); under CI
without them they FAIL rather than skip, so a missing artifact can never read as a pass."""
import csv
import json
import os

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
HAVE = os.path.exists(os.path.join(OUT, "metrics.json"))


@pytest.fixture(scope="module")
def m():
    if not HAVE:
        if os.environ.get("CI"):
            pytest.fail("ml/out/metrics.json missing under CI")
        pytest.skip("run embed.py, train.py and eval.py first")
    return json.load(open(os.path.join(OUT, "metrics.json")))


def test_trained_head_beats_zero_shot(m):
    s = m["systems"]
    assert s["clip_head"]["macro_f1"] > s["zero_shot"]["macro_f1"]


def test_held_out_shares_no_product_with_train(m):
    split = json.load(open(os.path.join(OUT, "split.json")))
    g = split["group"]
    assert set(g) == set(split["train"]) | set(split["held_out"])
    assert not {g[u] for u in split["held_out"]} & {g[u] for u in split["train"]}
    assert not set(split["held_out"]) & set(split["train"])


def test_every_class_has_enough_held_out(m):
    for c, v in m["systems"]["clip_head"]["per_class"].items():
        assert v["n"] >= 8, c


def test_head_json_matches_classes(m):
    h = json.load(open(os.path.join(HERE, "..", "public", "models", "head.json")))
    assert h["classes"] == m["classes"]
    assert len(h["coef"]) == 4 and all(len(r) == 512 for r in h["coef"]) and len(h["intercept"]) == 4
