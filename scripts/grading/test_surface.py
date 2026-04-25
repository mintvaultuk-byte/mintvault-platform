#!/usr/bin/env python3
"""Tests for surface.py using synthetic card fixtures with controlled damage."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

CARD_H = 3355
CARD_W = int(CARD_H * 0.716)
YELLOW_HSV = (30, 200, 230)


def make_clean_card() -> np.ndarray:
    """Clean card with realistic coloured art region — NO gradients that would
    create FFT artifacts masquerading as banding."""
    img = np.full((CARD_H, CARD_W, 3), 255, dtype=np.uint8)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hsv[100 : CARD_H - 100, 100 : CARD_W - 100] = YELLOW_HSV
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)

    # Flat art blocks — simulates coloured print without banding
    art_y0, art_y1 = 200, int(CARD_H * 0.55)
    art_x0, art_x1 = 200, CARD_W - 200

    # Fill with a medium blue-grey background
    cv2.rectangle(img, (art_x0, art_y0), (art_x1, art_y1), (120, 90, 60), thickness=-1)

    # Add a few irregular shapes simulating Pokémon art
    cv2.circle(img, (CARD_W // 2, (art_y0 + art_y1) // 2), 400, (180, 140, 80), thickness=-1)
    cv2.ellipse(img, (CARD_W // 2, (art_y0 + art_y1) // 2 - 50), (200, 150), 0, 0, 360,
                (220, 180, 100), thickness=-1)
    cv2.rectangle(img, (art_x0 + 100, art_y1 - 200), (art_x0 + 400, art_y1 - 50),
                  (80, 130, 160), thickness=-1)
    # A little noise to simulate print grain (randomized, no periodicity)
    rng = np.random.default_rng(7)
    noise = rng.integers(-5, 6, size=(art_y1 - art_y0, art_x1 - art_x0, 3), dtype=np.int16)
    patch = img[art_y0:art_y1, art_x0:art_x1].astype(np.int16) + noise
    img[art_y0:art_y1, art_x0:art_x1] = np.clip(patch, 0, 255).astype(np.uint8)

    return img


def add_scratches(img: np.ndarray, num: int, mean_length: int = 300) -> np.ndarray:
    """Add `num` linear scratches to the art region. Darker thin lines -
    simulates real scratches that remove ink/reveal white card below."""
    out = img.copy()
    rng = np.random.default_rng(42)
    art_y0, art_y1 = 250, int(CARD_H * 0.52)
    art_x0, art_x1 = 250, CARD_W - 250
    for _ in range(num):
        x1 = rng.integers(art_x0, art_x1)
        y1 = rng.integers(art_y0, art_y1)
        angle = rng.uniform(0, 2 * np.pi)
        length = int(mean_length + rng.normal(0, 50))
        x2 = int(x1 + length * np.cos(angle))
        y2 = int(y1 + length * np.sin(angle))
        # Scratches reveal card white → much brighter than the art around them
        cv2.line(out, (x1, y1), (x2, y2), (240, 240, 240), thickness=2)
    return out


def add_print_banding(img: np.ndarray, intensity: float = 15.0, period: int = 40) -> np.ndarray:
    """Add horizontal print-line banding across the art region."""
    out = img.copy().astype(np.float32)
    h, w = out.shape[:2]
    art_y0, art_y1 = 250, int(CARD_H * 0.52)
    for y in range(art_y0, art_y1):
        shift = intensity * np.sin(2 * np.pi * y / period)
        out[y, :, :] += shift
    return np.clip(out, 0, 255).astype(np.uint8)


def run_surface(image_path: str) -> dict:
    r = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "surface.py"), "--image", image_path],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"surface.py failed: {r.stderr}")
    return json.loads(r.stdout)


def describe(name: str, expected_range: tuple, got: dict) -> bool:
    lo, hi = expected_range
    passed = lo <= got["surface_score"] <= hi
    print(f"\n=== {name} ===")
    print(f"  scratches: {got['scratch_count']}  density: {got['scratch_density']}")
    print(f"  print_line_score: {got['print_line_score']}")
    print(f"  surface_score: {got['surface_score']}  (expected range {lo}-{hi})")
    print(f"  psa_ceiling: {got['psa_ceiling']}  confidence: {got['confidence']}")
    print(f"  {'✓ PASS' if passed else '✗ FAIL'}")
    return passed


def main():
    out_dir = Path("/tmp/surface-fixtures")
    out_dir.mkdir(exist_ok=True)
    all_pass = True

    # Test 1: clean art, should score high
    clean = make_clean_card()
    p = str(out_dir / "t1-clean.png")
    cv2.imwrite(p, clean)
    got = run_surface(p)
    all_pass &= describe("Test 1 — clean art (no defects)", (0.75, 1.0), got)

    # Test 2: a few scratches
    img = add_scratches(clean, 3, 200)
    p = str(out_dir / "t2-few-scratches.png")
    cv2.imwrite(p, img)
    got = run_surface(p)
    all_pass &= describe("Test 2 — 3 scratches", (0.5, 0.95), got)

    # Test 3: many scratches (damaged card)
    img = add_scratches(clean, 20, 250)
    p = str(out_dir / "t3-many-scratches.png")
    cv2.imwrite(p, img)
    got = run_surface(p)
    all_pass &= describe("Test 3 — 20 scratches (heavily damaged)", (0.0, 0.75), got)

    # Test 4: print-line banding
    img = add_print_banding(clean, intensity=25, period=30)
    p = str(out_dir / "t4-banding.png")
    cv2.imwrite(p, img)
    got = run_surface(p)
    # Banding should knock print_line_score down, which knocks total
    all_pass &= describe("Test 4 — print-line banding", (0.0, 0.95), got)

    # Test 5: combined damage
    img = add_scratches(clean, 10, 200)
    img = add_print_banding(img, intensity=20, period=30)
    p = str(out_dir / "t5-combined.png")
    cv2.imwrite(p, img)
    got = run_surface(p)
    all_pass &= describe("Test 5 — combined: 10 scratches + banding", (0.0, 0.8), got)

    # Test 6: verify ordering (clean > few scratches > many scratches)
    # This is the most important test — does the score DISCRIMINATE correctly?
    print("\n=== Test 6 — discrimination ordering ===")
    scores = {}
    for label, delta in [("clean", lambda c: c), ("few", lambda c: add_scratches(c, 3, 200)),
                         ("many", lambda c: add_scratches(c, 20, 250))]:
        img = delta(clean)
        p = str(out_dir / f"t6-{label}.png")
        cv2.imwrite(p, img)
        scores[label] = run_surface(p)["surface_score"]
    print(f"  clean={scores['clean']}  few={scores['few']}  many={scores['many']}")
    ordering_ok = scores["clean"] >= scores["few"] >= scores["many"]
    print(f"  {'✓ PASS' if ordering_ok else '✗ FAIL'}  (expected clean >= few >= many)")
    all_pass &= ordering_ok

    print("\n" + "=" * 50)
    print(f"{'SURFACE TESTS PASS ✓' if all_pass else 'SURFACE TESTS FAIL ✗'}")
    print("=" * 50)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
