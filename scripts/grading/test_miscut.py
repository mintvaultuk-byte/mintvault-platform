#!/usr/bin/env python3
"""Tests for miscut.py."""
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


def make_fixture_flat_borders(left: int, right: int, top: int, bottom: int) -> np.ndarray:
    """Perfect-cut fixture: yellow rectangle with uniform borders."""
    img = np.full((CARD_H, CARD_W, 3), 255, dtype=np.uint8)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hsv[top : CARD_H - bottom, left : CARD_W - right] = YELLOW_HSV
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    return img


def make_fixture_slanted_top(base_top: int, slant_px: int) -> np.ndarray:
    """Yellow border slants — top border is `base_top` on left, `base_top + slant_px` on right."""
    img = np.full((CARD_H, CARD_W, 3), 255, dtype=np.uint8)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # Fill the whole card as yellow first, then overwrite the slanted top region as white
    hsv[100 : CARD_H - 100, 100 : CARD_W - 100] = YELLOW_HSV
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    # Paint white a slanted region at the top
    for x in range(100, CARD_W - 100):
        t = base_top + int(slant_px * (x - 100) / (CARD_W - 200))
        img[100:100 + t - 100, x] = 255
    return img


def make_fixture_miscut(cut_shift_x: int, cut_shift_y: int) -> np.ndarray:
    """Simulate a miscut: the "cut" happens at a shifted position, so the yellow
    is off-centre on TWO sides simultaneously."""
    # Create a normal card, then "reshift" — crop and repaste
    img = np.full((CARD_H, CARD_W, 3), 255, dtype=np.uint8)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hsv[100:CARD_H - 100, 100:CARD_W - 100] = YELLOW_HSV
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)

    # Shift the image by (cut_shift_x, cut_shift_y). This simulates the printer's
    # cut being off-registration.
    M = np.float32([[1, 0, cut_shift_x], [0, 1, cut_shift_y]])
    img = cv2.warpAffine(img, M, (CARD_W, CARD_H), borderValue=(255, 255, 255))
    return img


def run_miscut(image_path: str) -> dict:
    r = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "miscut.py"), "--image", image_path],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"miscut.py failed: {r.stderr}")
    return json.loads(r.stdout)


def describe(name: str, expected_cls: list, got: dict, expect_slant: bool = None) -> bool:
    print(f"\n=== {name} ===")
    for side, data in got["side_thickness_px"].items():
        print(f"  {side}: mean={data['mean']}  cov={data['cov']}  samples={data['samples']}")
    print(f"  worst_side: {got['worst_side']}  worst_cov: {got['worst_cov']}")
    print(f"  classification: {got['classification']} (expected one of {expected_cls})")
    print(f"  slant_detected: {got['slant_detected']}")
    cls_ok = got["classification"] in expected_cls
    slant_ok = True if expect_slant is None else got["slant_detected"] == expect_slant
    passed = cls_ok and slant_ok
    print(f"  {'✓ PASS' if passed else '✗ FAIL'}")
    return passed


def main():
    out_dir = Path("/tmp/miscut-fixtures")
    out_dir.mkdir(exist_ok=True)
    all_pass = True

    # Test 1: perfectly cut card (uniform borders)
    img = make_fixture_flat_borders(100, 100, 100, 100)
    p = str(out_dir / "t1-perfect.png")
    cv2.imwrite(p, img)
    got = run_miscut(p)
    all_pass &= describe("Test 1 — perfectly cut", ["perfect"], got, expect_slant=False)

    # Test 2: still perfect but off-centre horizontally
    img = make_fixture_flat_borders(150, 70, 100, 100)
    p = str(out_dir / "t2-offcentre.png")
    cv2.imwrite(p, img)
    got = run_miscut(p)
    all_pass &= describe("Test 2 — off-centre but uniform borders (not a miscut)",
                         ["perfect", "slight"], got, expect_slant=False)

    # Test 3: slight slant on top border
    img = make_fixture_slanted_top(base_top=100, slant_px=30)
    p = str(out_dir / "t3-slight-slant.png")
    cv2.imwrite(p, img)
    got = run_miscut(p)
    all_pass &= describe("Test 3 — slight slant on top (30px over width)",
                         ["slight", "noticeable"], got)

    # Test 4: pronounced slant (miscut)
    img = make_fixture_slanted_top(base_top=100, slant_px=120)
    p = str(out_dir / "t4-miscut-slant.png")
    cv2.imwrite(p, img)
    got = run_miscut(p)
    all_pass &= describe("Test 4 — pronounced slant (miscut)",
                         ["noticeable", "miscut"], got, expect_slant=True)

    # Test 5: real miscut - factory cut was off
    img = make_fixture_miscut(cut_shift_x=40, cut_shift_y=30)
    p = str(out_dir / "t5-factory-miscut.png")
    cv2.imwrite(p, img)
    got = run_miscut(p)
    # Shift produces uniform borders but different sizes per side — classification
    # depends on whether the scanner crops. On our synthetic, borders remain uniform
    # so we expect perfect/slight classification.
    all_pass &= describe("Test 5 — factory shift (uniform-thickness, different sizes)",
                         ["perfect", "slight"], got)

    print("\n" + "=" * 50)
    print(f"{'MISCUT TESTS PASS ✓' if all_pass else 'MISCUT TESTS FAIL ✗'}")
    print("=" * 50)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
