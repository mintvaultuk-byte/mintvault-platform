#!/usr/bin/env python3
"""Tests for holofoil.py — verify hash stability and discrimination."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from test_surface import make_clean_card, add_scratches

CARD_H = 3355
CARD_W = int(CARD_H * 0.716)


def make_distinct_card(seed: int) -> np.ndarray:
    """Make a card with unique art based on seed — for different-card tests."""
    rng = np.random.default_rng(seed)
    img = make_clean_card()
    art_y0, art_y1 = 300, int(CARD_H * 0.50)
    art_x0, art_x1 = 300, CARD_W - 300
    # Place 8 random coloured shapes — this makes it truly distinctive
    for _ in range(8):
        cx = rng.integers(art_x0, art_x1)
        cy = rng.integers(art_y0, art_y1)
        r = rng.integers(60, 200)
        colour = (int(rng.integers(0, 255)), int(rng.integers(0, 255)), int(rng.integers(0, 255)))
        cv2.circle(img, (cx, cy), r, colour, thickness=-1)
    return img


def run_holo(image_path: str, compare: str = None) -> dict:
    cmd = [sys.executable, str(Path(__file__).parent / "holofoil.py"), "--image", image_path]
    if compare:
        cmd += ["--compare", compare]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"holofoil.py failed: {r.stderr}")
    return json.loads(r.stdout)


def main():
    out_dir = Path("/tmp/holo-fixtures")
    out_dir.mkdir(exist_ok=True)
    all_pass = True

    # Test 1: hash of identical image should be identical
    clean = make_clean_card()
    p1 = str(out_dir / "t1a-clean.png")
    p2 = str(out_dir / "t1b-clean-dup.png")
    cv2.imwrite(p1, clean)
    cv2.imwrite(p2, clean.copy())
    h1 = run_holo(p1)
    h2 = run_holo(p2)
    identical = (h1["phash"] == h2["phash"] and h1["dhash"] == h2["dhash"] and h1["whash"] == h2["whash"])
    print(f"\n=== Test 1 — hash stability (same image) ===")
    print(f"  phash: {h1['phash']}")
    print(f"  {'✓ PASS' if identical else '✗ FAIL'} (identical hashes)")
    all_pass &= identical

    # Test 2: comparison verdict "same_card" for identical
    result = run_holo(p1, compare=p2)
    c = result["comparison"]
    print(f"\n=== Test 2 — identical images compare as 'same_card' ===")
    print(f"  combined_distance: {c['combined_distance']}  verdict: {c['verdict']}")
    passed = c["verdict"] == "same_card" and c["combined_distance"] < 0.02
    print(f"  {'✓ PASS' if passed else '✗ FAIL'}")
    all_pass &= passed

    # Test 3: same card with a few scratches should still compare as "same" or "likely_same"
    scratched = add_scratches(clean, 5, 150)
    p3 = str(out_dir / "t3-scratched.png")
    cv2.imwrite(p3, scratched)
    result = run_holo(p1, compare=p3)
    c = result["comparison"]
    print(f"\n=== Test 3 — same card with 5 scratches — should still compare as same ===")
    print(f"  combined_distance: {c['combined_distance']}  verdict: {c['verdict']}")
    passed = c["verdict"] in ("same_card", "likely_same_card")
    print(f"  {'✓ PASS' if passed else '✗ FAIL'}")
    all_pass &= passed

    # Test 4: different cards should compare as "different_card"
    card_a = make_distinct_card(1)
    card_b = make_distinct_card(2)
    pa = str(out_dir / "t4a-card-a.png")
    pb = str(out_dir / "t4b-card-b.png")
    cv2.imwrite(pa, card_a)
    cv2.imwrite(pb, card_b)
    result = run_holo(pa, compare=pb)
    c = result["comparison"]
    print(f"\n=== Test 4 — different cards (distinct random art) ===")
    print(f"  combined_distance: {c['combined_distance']}  verdict: {c['verdict']}")
    passed = c["verdict"] in ("different_card", "uncertain")
    print(f"  {'✓ PASS' if passed else '✗ FAIL'} (expected different or uncertain)")
    all_pass &= passed

    # Test 5: small JPEG compression should NOT change verdict from same
    clean_j = "/tmp/holo-fixtures/t5-clean.jpg"
    cv2.imwrite(clean_j, clean, [cv2.IMWRITE_JPEG_QUALITY, 75])
    result = run_holo(p1, compare=clean_j)
    c = result["comparison"]
    print(f"\n=== Test 5 — PNG vs JPEG 75%-quality, same art ===")
    print(f"  combined_distance: {c['combined_distance']}  verdict: {c['verdict']}")
    passed = c["verdict"] in ("same_card", "likely_same_card")
    print(f"  {'✓ PASS' if passed else '✗ FAIL'} (JPEG compression should NOT fool the hash)")
    all_pass &= passed

    print("\n" + "=" * 50)
    print(f"{'HOLO TESTS PASS ✓' if all_pass else 'HOLO TESTS FAIL ✗'}")
    print("=" * 50)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
