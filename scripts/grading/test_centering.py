#!/usr/bin/env python3
"""
Synthesize Pokemon-card-like fixtures with KNOWN centering ratios and verify
that centering.py recovers them to within tolerance.

This lets us validate the algorithm without needing real MintVault scans in
the workspace.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np


CARD_H = 3355  # ~ real Pokémon scan at 1200 DPI
CARD_W = int(CARD_H * 0.716)  # matches scanner pipeline aspect
BORDER_WHITE = 255
YELLOW_HSV = (30, 200, 230)  # yellow Pokémon border
BACKGROUND = 255  # image background = white (same as scanner pipeline output)


def make_fixture(
    out_path: str,
    left_border_px: int,
    right_border_px: int,
    top_border_px: int,
    bottom_border_px: int,
    img_size: tuple[int, int] = (CARD_W, CARD_H),
    border_color_hsv: tuple[int, int, int] = YELLOW_HSV,
) -> None:
    """Generate a fake card with specified border widths (in px).

    The fixture has:
      - White background (equal to card), so scanner-already-cropped assumption holds.
      - A yellow rectangle inset by the specified border px on each side.
      - Simple dark "print" area inside the yellow so saturation transitions are clean.
    """
    w, h = img_size
    img = np.full((h, w, 3), BACKGROUND, dtype=np.uint8)  # all-white image (card)

    # Inner rect bounds
    x0 = left_border_px
    y0 = top_border_px
    x1 = w - right_border_px
    y1 = h - bottom_border_px

    # Build the image in HSV then convert — the yellow border needs full saturation.
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hsv[y0:y1, x0:x1] = border_color_hsv
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)

    # Put a dark "art" rectangle inside the yellow so the fixture has realistic content.
    art_pad = 60
    if x1 - x0 > 3 * art_pad and y1 - y0 > 3 * art_pad:
        cv2.rectangle(
            img,
            (x0 + art_pad, y0 + art_pad),
            (x1 - art_pad, y1 - art_pad),
            (40, 60, 80),
            thickness=-1,
        )

    cv2.imwrite(out_path, img)


CENTERING_PY = str(Path(__file__).parent / "centering.py")


def run_centering(image_path: str) -> dict:
    r = subprocess.run(
        [sys.executable, CENTERING_PY, "--image", image_path],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"centering.py failed: {r.stderr}")
    return json.loads(r.stdout)


def ratio_worse(a: int, b: int) -> float:
    return max(a, b) / (a + b) * 100


def describe(test_name: str, expected: dict, got: dict, tol_ratio: float = 1.5, tol_ceiling: int = 0):
    print(f"\n=== {test_name} ===")
    print(f"  Expected borders px: L={expected['left']} R={expected['right']} T={expected['top']} B={expected['bottom']}")
    print(f"  Got borders      px: L={got['borders_px']['left']} R={got['borders_px']['right']} T={got['borders_px']['top']} B={got['borders_px']['bottom']}")
    print(f"  Expected H ratio: {ratio_worse(expected['left'], expected['right']):.2f}  → got {got['ratios']['horizontal']}")
    print(f"  Expected V ratio: {ratio_worse(expected['top'], expected['bottom']):.2f}  → got {got['ratios']['vertical']}")
    print(f"  Display: H={got['display']['horizontal']}  V={got['display']['vertical']}")
    print(f"  PSA ceiling: {got['psa_ceiling']}  (expected around {expected.get('psa_ceiling', '?')})")
    print(f"  Confidence: {got['confidence']}")
    # Pass/fail
    h_err = abs(got["ratios"]["horizontal"] - ratio_worse(expected["left"], expected["right"]))
    v_err = abs(got["ratios"]["vertical"] - ratio_worse(expected["top"], expected["bottom"]))
    passed = h_err <= tol_ratio and v_err <= tol_ratio
    if "psa_ceiling" in expected:
        passed = passed and abs(got["psa_ceiling"] - expected["psa_ceiling"]) <= tol_ceiling
    print(f"  {'✓ PASS' if passed else '✗ FAIL'}  (H err {h_err:.2f}, V err {v_err:.2f}, tol {tol_ratio})")
    return passed


def main():
    Path("/tmp/fixtures").mkdir(exist_ok=True)
    all_pass = True

    # ---- Test 1: Perfect 50/50 centering ----
    borders = {"left": 100, "right": 100, "top": 100, "bottom": 100, "psa_ceiling": 10}
    p = "/tmp/fixtures/t1-perfect.png"
    make_fixture(p, borders["left"], borders["right"], borders["top"], borders["bottom"])
    got = run_centering(p)
    all_pass &= describe("Test 1 — perfect 50/50 centering", borders, got)

    # ---- Test 2: Moderate offset 60/40 horizontally ----
    borders = {"left": 120, "right": 80, "top": 100, "bottom": 100, "psa_ceiling": 9}
    p = "/tmp/fixtures/t2-60-40-horiz.png"
    make_fixture(p, borders["left"], borders["right"], borders["top"], borders["bottom"])
    got = run_centering(p)
    all_pass &= describe("Test 2 — 60/40 horizontal offset", borders, got)

    # ---- Test 3: Bad 70/30 vertical ----
    borders = {"left": 100, "right": 100, "top": 140, "bottom": 60, "psa_ceiling": 7}
    p = "/tmp/fixtures/t3-70-30-vert.png"
    make_fixture(p, borders["left"], borders["right"], borders["top"], borders["bottom"])
    got = run_centering(p)
    all_pass &= describe("Test 3 — 70/30 vertical offset", borders, got)

    # ---- Test 4: Asymmetric (realistic bad centering) ----
    borders = {"left": 130, "right": 70, "top": 130, "bottom": 70, "psa_ceiling": 8}
    p = "/tmp/fixtures/t4-asymmetric.png"
    make_fixture(p, borders["left"], borders["right"], borders["top"], borders["bottom"])
    got = run_centering(p)
    all_pass &= describe("Test 4 — asymmetric 65/35 both axes", borders, got)

    # ---- Test 5: Very narrow borders (tight centering, possible 10) ----
    borders = {"left": 40, "right": 40, "top": 50, "bottom": 50, "psa_ceiling": 10}
    p = "/tmp/fixtures/t5-tight.png"
    make_fixture(p, borders["left"], borders["right"], borders["top"], borders["bottom"])
    got = run_centering(p)
    all_pass &= describe("Test 5 — tight borders, perfect centering", borders, got)

    # ---- Test 6: Extreme miscentering (90/10) ----
    borders = {"left": 180, "right": 20, "top": 100, "bottom": 100, "psa_ceiling": 4}
    p = "/tmp/fixtures/t6-extreme.png"
    make_fixture(p, borders["left"], borders["right"], borders["top"], borders["bottom"])
    got = run_centering(p)
    all_pass &= describe("Test 6 — extreme 90/10", borders, got)

    print("\n" + "=" * 50)
    print(f"{'ALL TESTS PASSED ✓' if all_pass else 'SOME TESTS FAILED ✗'}")
    print("=" * 50)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
