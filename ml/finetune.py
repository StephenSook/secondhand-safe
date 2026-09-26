"""Deep fine-tune of the CLIP vision network itself (not only the head), measured on the SAME held-out split.

The shipped model keeps CLIP ViT-B/32 frozen and trains a logistic-regression head on its embeddings. This
script unfreezes the last N transformer blocks, the final layer norm and the projection, adds a linear head,
and trains them together with image augmentation. It reads ml/out/split.json (fixed before any training) so
the comparison with the shipped head is on identical held-out products, scored with ml/eval.py's metric.

  ml/.venv/bin/python ml/finetune.py [--blocks 2] [--epochs 8]   -> ml/out/finetune.json (+ weights, gitignored)
"""
import argparse
import csv
import json
import os
import random
import time

import numpy as np
import torch
from PIL import Image
from sklearn.metrics import confusion_matrix, f1_score
from torchvision import transforms
from transformers import CLIPVisionModelWithProjection

from eval import boot_ci
from fetch_images import image_path

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CLASSES = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"]
MEAN, STD = [0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]

TRAIN_TF = transforms.Compose([
    transforms.RandomResizedCrop(224, scale=(0.6, 1.0)), transforms.RandomHorizontalFlip(),
    transforms.ColorJitter(0.2, 0.2, 0.2), transforms.ToTensor(), transforms.Normalize(MEAN, STD)])
EVAL_TF = transforms.Compose([transforms.Resize(224), transforms.CenterCrop(224), transforms.ToTensor(), transforms.Normalize(MEAN, STD)])


class Net(torch.nn.Module):
    def __init__(self, blocks):
        super().__init__()
        self.clip = CLIPVisionModelWithProjection.from_pretrained("openai/clip-vit-base-patch32")
        for p in self.clip.parameters():
            p.requires_grad = False
        for layer in self.clip.vision_model.encoder.layers[-blocks:]:
            for p in layer.parameters():
                p.requires_grad = True
        for m in (self.clip.vision_model.post_layernorm, self.clip.visual_projection):
            for p in m.parameters():
                p.requires_grad = True
        self.head = torch.nn.Linear(512, len(CLASSES))

    def forward(self, x):
        e = self.clip(pixel_values=x).image_embeds
        return self.head(torch.nn.functional.normalize(e, dim=-1) * 10)


def load(url, tf):
    return tf(Image.open(image_path(url)).convert("RGB"))


def predict(net, urls, dev, bs=32):
    net.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(urls), bs):
            x = torch.stack([load(u, EVAL_TF) for u in urls[i:i + bs]]).to(dev)
            out.append(net(x).argmax(-1).cpu())
    return torch.cat(out).numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", type=int, default=2)
    ap.add_argument("--epochs", type=int, default=8)
    a = ap.parse_args()
    torch.manual_seed(13); random.seed(13); np.random.seed(13)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    split = json.load(open(os.path.join(OUT, "split.json")))
    label = {r["url"]: r["label"] for r in csv.DictReader(open(os.path.join(HERE, "labels.csv")))}
    train = [u for u in split["train"] if u in label and os.path.exists(image_path(u))]
    held = [u for u in split["held_out"] if u in label and os.path.exists(image_path(u))]
    assert not set(train) & set(held), "train and held-out overlap"
    yt = torch.tensor([CLASSES.index(label[u]) for u in train])
    yh = np.array([CLASSES.index(label[u]) for u in held])
    counts = torch.bincount(yt, minlength=len(CLASSES)).float()
    weights = (counts.sum() / (len(CLASSES) * counts)).to(dev)  # balanced, as in the shipped head

    net = Net(a.blocks).to(dev)
    backbone = [p for n, p in net.named_parameters() if p.requires_grad and not n.startswith("head")]
    opt = torch.optim.AdamW([{"params": backbone, "lr": 1e-5}, {"params": net.head.parameters(), "lr": 1e-3}], weight_decay=0.05)
    loss_fn = torch.nn.CrossEntropyLoss(weight=weights)
    t0 = time.time()
    for ep in range(a.epochs):
        net.train()
        order = torch.randperm(len(train)).tolist()
        total = 0.0
        for i in range(0, len(order), 16):
            idx = order[i:i + 16]
            x = torch.stack([load(train[j], TRAIN_TF) for j in idx]).to(dev)
            loss = loss_fn(net(x), yt[idx].to(dev))
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item() * len(idx)
        print(f"epoch {ep + 1}/{a.epochs} loss {total / len(train):.4f} ({time.time() - t0:.0f}s)", flush=True)

    p = predict(net, held, dev)
    other = CLASSES.index("other")
    shipped = json.load(open(os.path.join(OUT, "metrics.json")))
    res = {
        "what": f"CLIP ViT-B/32 fine-tuned: last {a.blocks} vision blocks + layer norm + projection + linear head, "
                f"{a.epochs} epochs, augmentation, balanced loss, seed 13, device {dev}",
        "train_n": len(train), "held_out_n": len(held),
        "macro_f1": round(float(f1_score(yh, p, average="macro", labels=range(len(CLASSES)), zero_division=0)), 4),
        "macro_f1_ci95": boot_ci(yh, p),
        "false_alarms_on_ordinary": int(((yh == other) & (p != other)).sum()), "ordinary_held_out": int((yh == other).sum()),
        "confusion": confusion_matrix(yh, p, labels=range(len(CLASSES))).tolist(),
        "shipped_systems_same_held_out": shipped.get("systems"),
        "seconds": round(time.time() - t0),
    }
    json.dump(res, open(os.path.join(OUT, f"finetune_b{a.blocks}.json"), "w"), indent=1)
    torch.save(net.state_dict(), os.path.join(OUT, f"finetune_b{a.blocks}.pt"))
    print(json.dumps({k: res[k] for k in ("macro_f1", "macro_f1_ci95", "false_alarms_on_ordinary", "ordinary_held_out", "confusion")}))


if __name__ == "__main__":
    main()
