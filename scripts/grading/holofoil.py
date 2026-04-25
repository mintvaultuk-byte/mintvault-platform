#!/usr/bin/env python3
"""
MintVault holofoil signature via perceptual hashing.

A Pokémon card's holographic region has a distinctive shimmer pattern that is
essentially unique per card (the holo foil is laid down in patterns the printer
controls). A perceptual hash of the art region allows two things:

  1. Authentication: compare the scanned card's art-region hash to a reference
     hash of the known genuine card and flag mismatches. The reference is built
     offline from known-genuine scans.
  2. Duplicate detection: identify when the same physical card appears twice in
     MintVault (same hash across different submissions).

This module does NOT compute a grade — it produces a hash signature for use
by the server-side authentication / cross-referencing layer.

Hash used: a combined dHash + pHash (8x8 each, 64 bits) giving 128 bits total.
Both are robust to small colour shifts and JPEG compression, but sensitive to
the actual foil pattern. This is standard pHash territory.

Usage:
    python3 holofoil.py --image card.jpg
    python3 holofoil.py --image card.jpg --compare other.jpg
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import cv2
import imagehash
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from utils import find_outer_card, extract_art_region

METHOD_VERSION = "holofoil.v1"


@dataclass
class HoloResult:
    art_size_px: dict
    phash: str
    dhash: str
    whash: str
    combined_hash: str          # concatenation for storage
    confidence: float           # 0..1, reflects art-region extraction quality
    method_version: str
    notes: list


def compute_hashes(art: np.ndarray) -> dict:
    """Compute perceptual hashes of the art region."""
    # Convert to PIL (imagehash uses PIL)
    art_rgb = cv2.cvtColor(art, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(art_rgb)

    phash = imagehash.phash(pil, hash_size=16)   # 256 bits
    dhash = imagehash.dhash(pil, hash_size=16)   # 256 bits
    whash = imagehash.whash(pil, hash_size=16)   # wavelet, catches foil shimmer well

    return {
        "phash": str(phash),
        "dhash": str(dhash),
        "whash": str(whash),
    }


def compare_hashes(h1: dict, h2: dict) -> dict:
    """Compare two holo-hash results. Returns distance metrics.

    Hamming distance: fraction of differing bits.
      0.00 → identical
      <0.05 → same card, minor scan variation
      0.05-0.15 → ambiguous — likely same card with significant scan differences
      >0.15 → different cards
    """
    p1 = imagehash.hex_to_hash(h1["phash"])
    p2 = imagehash.hex_to_hash(h2["phash"])
    d1 = imagehash.hex_to_hash(h1["dhash"])
    d2 = imagehash.hex_to_hash(h2["dhash"])
    w1 = imagehash.hex_to_hash(h1["whash"])
    w2 = imagehash.hex_to_hash(h2["whash"])

    p_dist = (p1 - p2) / len(p1.hash.flatten())
    d_dist = (d1 - d2) / len(d1.hash.flatten())
    w_dist = (w1 - w2) / len(w1.hash.flatten())

    # Combined: weighted toward whash which best captures foil texture
    combined = 0.3 * p_dist + 0.3 * d_dist + 0.4 * w_dist

    if combined < 0.05:
        verdict = "same_card"
    elif combined < 0.15:
        verdict = "likely_same_card"
    elif combined < 0.30:
        verdict = "uncertain"
    else:
        verdict = "different_card"

    return {
        "phash_distance": round(p_dist, 4),
        "dhash_distance": round(d_dist, 4),
        "whash_distance": round(w_dist, 4),
        "combined_distance": round(combined, 4),
        "verdict": verdict,
    }


def compute_signature(image_path: str) -> HoloResult:
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)

    outer = find_outer_card(img)
    notes = []

    try:
        art = extract_art_region(img, outer)
        confidence = 0.95
    except RuntimeError as e:
        # Fallback: use the whole card minus a 10% margin
        ox0, oy0, ox1, oy1 = outer
        mw = int((ox1 - ox0) * 0.10)
        mh = int((oy1 - oy0) * 0.10)
        art = img[oy0 + mh : oy1 - mh, ox0 + mw : ox1 - mw]
        notes.append(f"art region extraction failed ({e}) — using fallback full-card-minus-margin")
        confidence = 0.6

    hashes = compute_hashes(art)
    combined = hashes["phash"] + "-" + hashes["dhash"] + "-" + hashes["whash"]

    ah, aw = art.shape[:2]
    return HoloResult(
        art_size_px={"w": int(aw), "h": int(ah)},
        phash=hashes["phash"],
        dhash=hashes["dhash"],
        whash=hashes["whash"],
        combined_hash=combined,
        confidence=round(confidence, 3),
        method_version=METHOD_VERSION,
        notes=notes,
    )


def main():
    parser = argparse.ArgumentParser(description="Compute holofoil hash signature of a card.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--compare", help="Optional second image path — compute pairwise distance.")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    try:
        result = compute_signature(args.image)
        payload = asdict(result)
        if args.compare:
            other = compute_signature(args.compare)
            comparison = compare_hashes(
                {"phash": result.phash, "dhash": result.dhash, "whash": result.whash},
                {"phash": other.phash, "dhash": other.dhash, "whash": other.whash},
            )
            payload["compare_against"] = args.compare
            payload["comparison"] = comparison
    except Exception as e:
        err = {"error": str(e), "method_version": METHOD_VERSION}
        print(json.dumps(err), file=sys.stderr)
        sys.exit(1)

    out = json.dumps(payload, indent=2)
    if args.json_out:
        Path(args.json_out).write_text(out)
    else:
        print(out)


if __name__ == "__main__":
    main()
