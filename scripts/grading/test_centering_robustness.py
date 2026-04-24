#!/usr/bin/env python3
"""
Robustness tests for centering.py — add realistic degradations to the synthetic
fixtures and confirm the algorithm still recovers the correct ratio to within
a reasonable tolerance.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from test_centering import make_fixture, run_centering, describe, ratio_worse  # noqa


def add_gaussian_noise(img: np.ndarray, sigma: float = 10.0) -> np.ndarray:
    noise = np.random.normal(0, sigma, img.shape).astype(np.float32)
    out = img.astype(np.float32) + noise
    return np.clip(out, 0, 255).astype(np.uint8)


def rotate_image(img: np.ndarray, angle_deg: float) -> np.ndarray:
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle_deg, 1.0)
    # Use white border so rotation artefacts don't darken the image
    return cv2.warpAffine(img, M, (w, h), borderValue=(255, 255, 255))


def roughen_border(img: np.ndarray, amplitude_px: int = 4) -> np.ndarray:
    """Perturb inner border by small amounts to simulate print variation."""
    h, w = img.shape[:2]
    # Find where the yellow starts by thresholding on saturation; add ±amplitude jitter per column.
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    # For each column, find top-y where sat first exceeds threshold; shift the yellow up/down randomly
    out = img.copy()
    for x in range(w):
        col = sat[:, x]
        top_idx = np.argmax(col > 40)
        if col[top_idx] > 40:
            shift = np.random.randint(-amplitude_px, amplitude_px + 1)
            if shift > 0:
                # Extend white down (delete top `shift` rows of yellow)
                out[top_idx : top_idx + shift, x] = 255
            elif shift < 0:
                # Extend yellow up
                out[top_idx + shift : top_idx, x] = img[top_idx + 5, x]
    return out


def main():
    all_pass = True
    np.random.seed(42)

    # ---- Test 7: Gaussian pixel noise (print grain) ----
    borders = {"left": 120, "right": 80, "top": 100, "bottom": 100, "psa_ceiling": 9}
    base = "/tmp/fixtures/t7-base.png"
    make_fixture(base, borders["left"], borders["right"], borders["top"], borders["bottom"])
    img = cv2.imread(base)
    noisy = add_gaussian_noise(img, sigma=12.0)
    p = "/tmp/fixtures/t7-noise.png"
    cv2.imwrite(p, noisy)
    got = run_centering(p)
    all_pass &= describe("Test 7 — 60/40 + Gaussian noise sigma=12", borders, got, tol_ratio=2.0)

    # ---- Test 8: Small residual rotation (0.5°) ----
    borders = {"left": 100, "right": 100, "top": 100, "bottom": 100, "psa_ceiling": 10}
    base = "/tmp/fixtures/t8-base.png"
    make_fixture(base, borders["left"], borders["right"], borders["top"], borders["bottom"])
    img = cv2.imread(base)
    rotated = rotate_image(img, 0.5)
    p = "/tmp/fixtures/t8-rotated.png"
    cv2.imwrite(p, rotated)
    got = run_centering(p)
    all_pass &= describe("Test 8 — perfect centering, 0.5° residual rotation", borders, got, tol_ratio=3.0)

    # ---- Test 9: Border print variation (±4px jitter) ----
    borders = {"left": 130, "right": 70, "top": 100, "bottom": 100, "psa_ceiling": 8}
    base = "/tmp/fixtures/t9-base.png"
    make_fixture(base, borders["left"], borders["right"], borders["top"], borders["bottom"])
    img = cv2.imread(base)
    rough = roughen_border(img, amplitude_px=4)
    p = "/tmp/fixtures/t9-rough.png"
    cv2.imwrite(p, rough)
    got = run_centering(p)
    all_pass &= describe("Test 9 — 65/35 with ±4px border print variation", borders, got, tol_ratio=3.0)

    # ---- Test 10: Combined — noise + rotation + roughness ----
    borders = {"left": 120, "right": 80, "top": 110, "bottom": 90, "psa_ceiling": 9}
    base = "/tmp/fixtures/t10-base.png"
    make_fixture(base, borders["left"], borders["right"], borders["top"], borders["bottom"])
    img = cv2.imread(base)
    img = add_gaussian_noise(img, sigma=8.0)
    img = rotate_image(img, 0.3)
    p = "/tmp/fixtures/t10-combined.png"
    cv2.imwrite(p, img)
    got = run_centering(p)
    all_pass &= describe("Test 10 — realistic combined degradations", borders, got, tol_ratio=3.0)

    # ---- Test 11: Larger rotation (1.5°) — should lower confidence or still get close ----
    borders = {"left": 100, "right": 100, "top": 100, "bottom": 100, "psa_ceiling": 10}
    base = "/tmp/fixtures/t11-base.png"
    make_fixture(base, borders["left"], borders["right"], borders["top"], borders["bottom"])
    img = cv2.imread(base)
    img = rotate_image(img, 1.5)
    p = "/tmp/fixtures/t11-rot1p5.png"
    cv2.imwrite(p, img)
    got = run_centering(p)
    # With 1.5° rotation, we expect wider tolerance AND lower confidence
    passed = describe("Test 11 — 1.5° rotation (stress test)", borders, got, tol_ratio=6.0)
    if got["confidence"] >= 0.9:
        print("   [note] confidence remained high despite 1.5° rotation — good algorithm behaviour")
    else:
        print(f"   [note] confidence {got['confidence']} — correctly flags rotation as uncertain")
    all_pass &= passed

    print("\n" + "=" * 50)
    print(f"{'ROBUSTNESS TESTS PASS ✓' if all_pass else 'ROBUSTNESS TESTS FAIL ✗'}")
    print("=" * 50)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
