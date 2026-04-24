#!/usr/bin/env python3
"""
MintVault centering measurement tool.

Usage:
    python3 centering.py --image card.jpg
    python3 centering.py --image card.jpg --json-out result.json
    python3 centering.py --image card.jpg --debug-viz debug.png

Takes an aligned card scan from the V850 pipeline and returns deterministic
centering measurements and the implied PSA-grade ceiling.

Designed to run as a CLI the MintVault server shells out to. Exit code 0 on
success; result on stdout as JSON. Non-zero on failure with error JSON on stderr.

Algorithm: detect the outer card edge and the inner print frame via a robust
per-edge sampling sweep; compute border widths in pixels; convert to the
standard horizontal/vertical ratio PSA uses for centering.
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

METHOD_VERSION = "centering.v1"

# PSA-style centering thresholds. Ratio = larger_side / (larger+smaller) * 100.
# e.g. 55 means the worse side is 55/45.
# Industry-standard centering tolerance by grade (PSA-like).
PSA_THRESHOLDS = [
    (55.0, 10),   # 55/45 or better → Gem Mint 10 possible
    (60.0, 9),    # 60/40 or better → Mint 9
    (65.0, 8),    # 65/35 or better → NM-MT 8
    (70.0, 7),    # 70/30 or better → NM 7
    (75.0, 6),    # 75/25 or better → EX-MT 6
    (80.0, 5),    # 80/20 or better → EX 5
    (90.0, 4),    # 90/10 or better → VG-EX 4
    (100.0, 3),   # worse than 90/10 → ≤VG 3
]


def psa_ceiling(worst_ratio: float) -> int:
    """Given the worse-side ratio (e.g. 55.0 means 55/45), return the PSA ceiling."""
    for threshold, grade in PSA_THRESHOLDS:
        if worst_ratio <= threshold:
            return grade
    return 1


@dataclass
class CenteringResult:
    card_size_px: dict
    borders_px: dict          # {top, bottom, left, right}
    ratios: dict              # {horizontal, vertical}  worse-side %
    display: dict             # human-readable e.g. {"horizontal": "55/45", ...}
    psa_ceiling: int          # worst of the two axes
    confidence: float         # 0..1
    method_version: str
    notes: list


def find_outer_card(img: np.ndarray) -> tuple[int, int, int, int]:
    """Locate the outer card boundary. Returns (x0, y0, x1, y1) inclusive.

    Assumes the scanner pipeline has already aspect-tightened and isolated the
    card; outer boundary will be at or very near the image edges.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img

    # Otsu against a light background; card is the bright region.
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # If most pixels are white (because background is also white like the card),
    # we fall back to assuming image IS the card.
    white_frac = np.mean(thresh > 0)
    if white_frac > 0.95:
        return 0, 0, w - 1, h - 1

    # Otherwise pick the largest contour and use its bounding box.
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0, 0, w - 1, h - 1
    c = max(contours, key=cv2.contourArea)
    x, y, cw, ch = cv2.boundingRect(c)
    return x, y, x + cw - 1, y + ch - 1


def saturation_channel(img: np.ndarray) -> np.ndarray:
    """Return the saturation channel of the image. White border = low sat; coloured border = high sat."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return hsv[:, :, 1]


def detect_inner_edge(
    sat: np.ndarray,
    outer_bbox: tuple[int, int, int, int],
    side: str,
    sample_count: int = 21,
    sat_threshold: int = 40,
) -> tuple[int, float]:
    """Scan inward from one side and locate the inner print frame.

    Returns (position_px, confidence_0_to_1).
    `position_px` is in image coordinates along the relevant axis.
    `confidence` is inter-sample agreement (stddev normalised).

    side: 'top' | 'bottom' | 'left' | 'right'
    """
    x0, y0, x1, y1 = outer_bbox
    H, W = sat.shape[:2]

    # Calculate the direction to scan and the band of sample positions.
    positions = []

    if side == "top":
        # Sample at evenly-spaced x positions; for each, scan y from y0 downward.
        samples_x = np.linspace(x0 + (x1 - x0) * 0.15, x0 + (x1 - x0) * 0.85, sample_count).astype(int)
        for sx in samples_x:
            col = sat[y0 : y1 + 1, sx]
            # Skip the outermost few pixels (may be scanner artefact)
            start = 5
            # Find first index where sat exceeds threshold.
            idx = np.argmax(col[start:] >= sat_threshold)
            if col[start + idx] >= sat_threshold:
                positions.append(y0 + start + idx)
    elif side == "bottom":
        samples_x = np.linspace(x0 + (x1 - x0) * 0.15, x0 + (x1 - x0) * 0.85, sample_count).astype(int)
        for sx in samples_x:
            col = sat[y0 : y1 + 1, sx][::-1]
            start = 5
            idx = np.argmax(col[start:] >= sat_threshold)
            if col[start + idx] >= sat_threshold:
                positions.append(y1 - (start + idx))
    elif side == "left":
        samples_y = np.linspace(y0 + (y1 - y0) * 0.15, y0 + (y1 - y0) * 0.85, sample_count).astype(int)
        for sy in samples_y:
            row = sat[sy, x0 : x1 + 1]
            start = 5
            idx = np.argmax(row[start:] >= sat_threshold)
            if row[start + idx] >= sat_threshold:
                positions.append(x0 + start + idx)
    elif side == "right":
        samples_y = np.linspace(y0 + (y1 - y0) * 0.15, y0 + (y1 - y0) * 0.85, sample_count).astype(int)
        for sy in samples_y:
            row = sat[sy, x0 : x1 + 1][::-1]
            start = 5
            idx = np.argmax(row[start:] >= sat_threshold)
            if row[start + idx] >= sat_threshold:
                positions.append(x1 - (start + idx))
    else:
        raise ValueError(f"Unknown side: {side}")

    if not positions:
        return -1, 0.0

    positions_arr = np.array(positions)
    median = int(np.median(positions_arr))
    # Inter-sample agreement: how tightly the samples cluster around the median.
    mad = np.median(np.abs(positions_arr - median))
    # Turn MAD into a 0..1 confidence. MAD of 0 = perfect; MAD > 20px = low confidence.
    confidence = float(np.clip(1.0 - mad / 20.0, 0.0, 1.0))
    return median, confidence


def measure_centering(
    image_path: str,
    sat_threshold: int = 40,
    sample_count: int = 21,
) -> CenteringResult:
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    H, W = img.shape[:2]
    notes = []

    outer = find_outer_card(img)
    ox0, oy0, ox1, oy1 = outer

    # If the outer bbox is basically the whole image, note it.
    if ox0 <= 2 and oy0 <= 2 and ox1 >= W - 3 and oy1 >= H - 3:
        notes.append("outer card boundary equals image bounds (scanner pipeline assumption)")

    sat = saturation_channel(img)

    top, top_conf = detect_inner_edge(sat, outer, "top", sample_count, sat_threshold)
    bottom, bottom_conf = detect_inner_edge(sat, outer, "bottom", sample_count, sat_threshold)
    left, left_conf = detect_inner_edge(sat, outer, "left", sample_count, sat_threshold)
    right, right_conf = detect_inner_edge(sat, outer, "right", sample_count, sat_threshold)

    if -1 in (top, bottom, left, right):
        notes.append("inner frame not detected on all 4 sides — card may lack a coloured border or be rotated")
        raise RuntimeError("inner frame detection failed on one or more sides")

    borders = {
        "top": int(top - oy0),
        "bottom": int(oy1 - bottom),
        "left": int(left - ox0),
        "right": int(ox1 - right),
    }

    # Ratios. Use the *worse* side for PSA-style display.
    h_total = borders["left"] + borders["right"]
    v_total = borders["top"] + borders["bottom"]

    if h_total <= 0 or v_total <= 0:
        raise RuntimeError(f"invalid border totals: h={h_total}, v={v_total}")

    h_ratio = max(borders["left"], borders["right"]) / h_total * 100
    v_ratio = max(borders["top"], borders["bottom"]) / v_total * 100

    # Display: "55/45" style
    def fmt_axis(a: int, b: int) -> str:
        tot = a + b
        return f"{round(a / tot * 100)}/{round(b / tot * 100)}"

    display = {
        "horizontal": fmt_axis(borders["left"], borders["right"]),
        "vertical": fmt_axis(borders["top"], borders["bottom"]),
    }

    # PSA ceiling = worst of the two axes
    ceiling = min(psa_ceiling(h_ratio), psa_ceiling(v_ratio))

    # Overall confidence = product of per-side confidences
    confidence = float(top_conf * bottom_conf * left_conf * right_conf)

    if confidence < 0.6:
        notes.append(f"low detection confidence ({confidence:.2f}) — consider flagging for manual review")

    return CenteringResult(
        card_size_px={"w": int(ox1 - ox0 + 1), "h": int(oy1 - oy0 + 1)},
        borders_px=borders,
        ratios={"horizontal": round(h_ratio, 2), "vertical": round(v_ratio, 2)},
        display=display,
        psa_ceiling=ceiling,
        confidence=round(confidence, 3),
        method_version=METHOD_VERSION,
        notes=notes,
    )


def write_debug_viz(image_path: str, result: CenteringResult, out_path: str) -> None:
    """Annotate the image with detected borders for visual inspection."""
    img = cv2.imread(image_path)
    H, W = img.shape[:2]
    ox0, oy0 = 0, 0
    ox1, oy1 = W - 1, H - 1
    b = result.borders_px

    # Draw outer (green) and inner (red) rectangles.
    cv2.rectangle(img, (ox0, oy0), (ox1, oy1), (0, 255, 0), 3)
    cv2.rectangle(
        img,
        (ox0 + b["left"], oy0 + b["top"]),
        (ox1 - b["right"], oy1 - b["bottom"]),
        (0, 0, 255),
        3,
    )

    # Labels
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(img, f"H: {result.display['horizontal']}", (20, 50), font, 1.2, (0, 0, 255), 2)
    cv2.putText(img, f"V: {result.display['vertical']}", (20, 90), font, 1.2, (0, 0, 255), 2)
    cv2.putText(img, f"Ceiling: PSA {result.psa_ceiling}", (20, 130), font, 1.2, (0, 0, 255), 2)
    cv2.putText(img, f"Conf: {result.confidence}", (20, 170), font, 1.0, (0, 0, 255), 2)

    cv2.imwrite(out_path, img)


def main():
    parser = argparse.ArgumentParser(description="Measure card centering from an aligned scan.")
    parser.add_argument("--image", required=True, help="Path to aligned card image.")
    parser.add_argument("--json-out", help="Write JSON result to this file (else stdout).")
    parser.add_argument("--debug-viz", help="Write debug visualization PNG to this path.")
    parser.add_argument("--sat-threshold", type=int, default=40,
                        help="Saturation threshold for inner edge detection (default 40).")
    parser.add_argument("--sample-count", type=int, default=21,
                        help="Number of sample lines per edge (default 21).")
    args = parser.parse_args()

    try:
        result = measure_centering(args.image, args.sat_threshold, args.sample_count)
    except Exception as e:
        err = {"error": str(e), "method_version": METHOD_VERSION}
        print(json.dumps(err), file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(asdict(result), indent=2)
    if args.json_out:
        Path(args.json_out).write_text(payload)
    else:
        print(payload)

    if args.debug_viz:
        write_debug_viz(args.image, result, args.debug_viz)


if __name__ == "__main__":
    main()
