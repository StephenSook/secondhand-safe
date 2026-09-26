"""CLIP (and optional DINOv2) image embeddings for every downloaded photo, plus CLIP zero-shot scores.

CLIP weights are openai/clip-vit-base-patch32, the same weights transformers.js ships as
Xenova/clip-vit-base-patch32, so the head trained here runs unchanged in Node (PLAN 2.8).

  python ml/embed.py            -> ml/out/emb_clip.npz  (urls, emb [N,512] L2-normalized, zs [N,4])
  python ml/embed.py --dino     -> ml/out/emb_dino.npz  (urls, emb [N,768] L2-normalized)
"""
import json
import os
import sys

import numpy as np
import torch
from PIL import Image

from fetch_images import image_path

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
CLASSES = ["inclined_or_inbed_sleeper", "crib_bumper", "drop_side_crib", "other"]
# Zero-shot prompts: the baseline the trained head has to beat on held-out listing photos.
PROMPTS = {
    "inclined_or_inbed_sleeper": ["a photo of an inclined infant sleeper seat", "a photo of a baby rock n play sleeper",
                                  "a photo of a baby lounger pod for an adult bed"],
    "crib_bumper": ["a photo of padded crib bumpers tied around a crib", "a photo of a crib bumper pad set"],
    "drop_side_crib": ["a photo of an old drop-side baby crib with a side rail that slides down",
                       "a photo of a wooden drop side crib"],
    "other": ["a photo of a baby high chair", "a photo of a baby stroller", "a photo of a modern baby crib",
              "a photo of a bassinet on a stand", "a photo of a pack n play playard", "a photo of a car seat",
              "a photo of a baby swing", "a photo of baby clothes and toys", "a photo of furniture"],
}


def all_urls():
    urls = []
    for name in ("cpsc_images.jsonl", "listings.jsonl"):
        p = os.path.join(HERE, "data", name)
        if os.path.exists(p):
            for line in open(p):
                urls += json.loads(line)["images"][:1]
    return [u for u in dict.fromkeys(urls) if os.path.exists(image_path(u))]


def feats(o):
    """transformers 5 returns an output object; its pooler_output is the projected CLIP embedding."""
    return o if isinstance(o, torch.Tensor) else o.pooler_output


def load(u):
    try:
        return Image.open(image_path(u)).convert("RGB")
    except Exception:
        return None


def clip_embed(urls, bs=32):
    from transformers import CLIPModel, CLIPProcessor
    m = CLIPModel.from_pretrained("openai/clip-vit-base-patch32").eval()
    proc = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
    with torch.no_grad():
        texts = [t for c in CLASSES for t in PROMPTS[c]]
        te = feats(m.get_text_features(**proc(text=texts, return_tensors="pt", padding=True)))
        te = te / te.norm(dim=-1, keepdim=True)
        owner = np.array([i for i, c in enumerate(CLASSES) for _ in PROMPTS[c]])
        keep, embs = [], []
        for i in range(0, len(urls), bs):
            batch = [(u, load(u)) for u in urls[i:i + bs]]
            batch = [(u, im) for u, im in batch if im is not None]
            if not batch:
                continue
            e = feats(m.get_image_features(**proc(images=[im for _, im in batch], return_tensors="pt")))
            embs.append((e / e.norm(dim=-1, keepdim=True)).numpy())
            keep += [u for u, _ in batch]
            print(f"clip {i + len(batch)}/{len(urls)}", flush=True)
        emb = np.concatenate(embs)
        sims = 100.0 * emb @ te.numpy().T
        # class score = best prompt of that class; softmax over classes
        cls = np.stack([sims[:, owner == k].max(1) for k in range(len(CLASSES))], 1)
        zs = np.exp(cls - cls.max(1, keepdims=True))
        zs /= zs.sum(1, keepdims=True)
    return keep, emb, zs


def dino_embed(urls, bs=16):
    from transformers import AutoImageProcessor, AutoModel
    m = AutoModel.from_pretrained("facebook/dinov2-base").eval()
    proc = AutoImageProcessor.from_pretrained("facebook/dinov2-base")
    keep, embs = [], []
    with torch.no_grad():
        for i in range(0, len(urls), bs):
            batch = [(u, load(u)) for u in urls[i:i + bs]]
            batch = [(u, im) for u, im in batch if im is not None]
            if not batch:
                continue
            e = m(**proc(images=[im for _, im in batch], return_tensors="pt")).pooler_output
            embs.append((e / e.norm(dim=-1, keepdim=True)).numpy())
            keep += [u for u, _ in batch]
            print(f"dino {i + len(batch)}/{len(urls)}", flush=True)
    return keep, np.concatenate(embs)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    torch.set_num_threads(4)
    urls = all_urls()
    if not urls:
        sys.exit("no downloaded images; run fetch_images.py first")
    if "--dino" in sys.argv:
        keep, emb = dino_embed(urls)
        np.savez(os.path.join(OUT, "emb_dino.npz"), urls=np.array(keep), emb=emb)
    else:
        keep, emb, zs = clip_embed(urls)
        np.savez(os.path.join(OUT, "emb_clip.npz"), urls=np.array(keep), emb=emb, zs=zs, classes=np.array(CLASSES))
    print(f"embedded {len(keep)} of {len(urls)} images")
