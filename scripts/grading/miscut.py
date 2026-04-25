#!/usr/bin/env python3
"""
MintVault miscut / print-alignment detection.

A miscut card has uneven "white-to-yellow" border widths beyond what normal
centering variation would explain. This module measures the distribution of
white-border thickness along all four sides of a card and flags extreme
variation consistent with a miscut or factory-alignment defect.

Key metric: coefficient-of-variation (CoV = std/mean) of border thickness
along each side. A well-cut card has CoV < 0.05 on each side. A miscut card
typically has CoV > 0.15 on at least one side because the yellow border
slants into or away from the outer card edge.

Note: centering.py already computes per-side median thickness. This module
adds the along-side variation measurement — a NEW signal that's orthogonal
to centering.

Usage:
    python3 miscut.py --image card.jpg [--json-out result.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from utils import find_outer_card

METHOD_VERSION = "miscut.v1"

# Thresholds: CoV of border width per side
# Well-cut (production): CoV 0-0.05
# Slight variation: 0.05-0.10
# Noticeable misalignment: 0.10-0.20
# Miscut: >0.20
MISCUT_THRESHOLDS = [
    (0.05, "perfect"),
    (0.10, "slight"),
    (0.20, "noticeable"),
    (float("inf"), "miscut"),
]


@dataclass
class MiscutResult:
    card_size_px: dict
    side_thickness_px: dict     # per-side lists summary: {mean, std, cov, min, max}
    worst_side: str
    worst_cov: float
    classification: str         # "perfect" | "slight" | "noticeable" | "miscut"
    slant_detected: bool        # true if thickness trends monotonically across a side
    confidence: float
    method_version: str
    notes: list


def classify(cov: float) -> str:
    for t, label in MISCUT_THRESHOLDS:
        if cov <= t:
            return label
    return "miscut"


def measure_side_thickness(sat: np.ndarray, outer: tuple, side: str, samples: int = 41,
                           sat_threshold: int = 40) -> list:
    """Measure white-border thickness at many positions along one side.

    Returns list of thicknesses (px). None entries for failed samples are dropped.
    """
    ox0, oy0, ox1, oy1 = outer
    thicknesses = []

    if side == "top":
        sample_positions = np.linspace(ox0 + (ox1 - ox0) * 0.05,
                                       ox0 + (ox1 - ox0) * 0.95, samples).astype(int)
        for sx in sample_positions:
            col = sat[oy0:oy1 + 1, sx]
            start = 5
            idx = np.argmax(col[start:] >= sat_threshold)
            if col[start + idx] >= sat_threshold:
                thicknesses.append(start + idx)
    elif side == "bottom":
        sample_positions = np.linspace(ox0 + (ox1 - ox0) * 0.05,
                                       ox0 + (ox1 - ox0) * 0.95, samples).astype(int)
        for sx in sample_positions:
            col = sat[oy0:oy1 + 1, sx][::-1]
            start = 5
            idx = np.argmax(col[start:] >= sat_threshold)
            if col[start + idx] >= sat_threshold:
                thicknesses.append(start + idx)
    elif side == "left":
        sample_positions = np.linspace(oy0 + (oy1 - oy0) * 0.05,
                                       oy0 + (oy1 - oy0) * 0.95, samples).astype(int)
        for sy in sample_positions:
            row = sat[sy, ox0:ox1 + 1]
            start = 5
            idx = np.argmax(row[start:] >= sat_threshold)
            if row[start + idx] >= sat_threshold:
                thicknesses.append(start + idx)
    elif side == "right":
        sample_positions = np.linspace(oy0 + (oy1 - oy0) * 0.05,
                                       oy0 + (oy1 - oy0) * 0.95, samples).astype(int)
        for sy in sample_positions:
            row = sat[sy, ox0:ox1 + 1][::-1]
            start = 5
            idx = np.argmax(row[start:] >= sat_threshold)
            if row[start + idx] >= sat_threshold:
                thicknesses.append(start + idx)

    return thicknesses


def detect_slant(thicknesses: list) -> bool:
    """True if thickness trends monotonically across the side — indicates a slanted cut."""
    if len(thicknesses) < 10:
        return False
    arr = np.array(thicknesses, dtype=np.float32)
    # Linear regression slope relative to overall mean
    x = np.arange(len(arr))
    slope = np.polyfit(x, arr, 1)[0]
    slope_per_unit = abs(slope) * len(arr)  # total change from start to end
    mean = arr.mean() + 1e-6
    return (slope_per_unit / mean) > 0.3  # > 30% change start-to-end = slanted


def summarise(thicknesses: list) -> dict:
    if not thicknesses:
        return {"samples": 0, "mean": None, "std": None, "cov": None, "min": None, "max": None}
    a = np.array(thicknesses, dtype=np.float32)
    mean = float(a.mean())
    std = float(a.std())
    cov = float(std / (mean + 1e-6))
    return {
        "samples": int(len(thicknesses)),
        "mean": round(mean, 2),
        "std": round(std, 2),
        "cov": round(cov, 4),
        "min": int(a.min()),
        "max": int(a.max()),
    }


def measure_miscut(image_path: str) -> MiscutResult:
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(image_path)

    outer = find_outer_card(img)
    ox0, oy0, ox1, oy1 = outer
    notes = []

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]

    side_data = {}
    covs = {}
    slants = {}
    for side in ["top", "bottom", "left", "right"]:
        thicknesses = measure_side_thickness(sat, outer, side)
        side_data[side] = summarise(thicknesses)
        if side_data[side]["cov"] is not None:
            covs[side] = side_data[side]["cov"]
            slants[side] = detect_slant(thicknesses)

    if not covs:
        raise RuntimeError("no side border thickness could be measured — inner frame not detectable")

    worst_side = max(covs, key=covs.get)
    worst_cov = covs[worst_side]
    cls = classify(worst_cov)
    slant = any(slants.values())

    # Confidence: based on number of successful samples across sides
    sample_counts = [side_data[s]["samples"] or 0 for s in side_data]
    avg_samples = np.mean(sample_counts) if sample_counts else 0
    confidence = float(np.clip(avg_samples / 41.0, 0.0, 1.0))

    if cls in ("noticeable", "miscut"):
        notes.append(f"possible {cls} — worst CoV on {worst_side} = {worst_cov:.3f}")
    if slant:
        slanted = [s for s, v in slants.items() if v]
        notes.append(f"slant detected on side(s): {slanted}")

    return MiscutResult(
        card_size_px={"w": int(ox1 - ox0 + 1), "h": int(oy1 - oy0 + 1)},
        side_thickness_px=side_data,
        worst_side=worst_side,
        worst_cov=round(worst_cov, 4),
        classification=cls,
        slant_detected=slant,
        confidence=round(confidence, 3),
        method_version=METHOD_VERSION,
        notes=notes,
    )


def main():
    parser = argparse.ArgumentParser(description="Detect miscut / print-alignment defects.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--json-out")
    args = parser.parse_args()

    try:
        result = measure_miscut(args.image)
    except Exception as e:
        err = {"error": str(e), "method_version": METHOD_VERSION}
        print(json.dumps(err), file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(asdict(result), indent=2)
    if args.json_out:
        Path(args.json_out).write_text(payload)
    else:
        print(payload)


if __name__ == "__main__":
    main()
