#!/usr/bin/env python3
"""
MintVault surface defect detection.

Detects scratches and print-line defects in the art region of a Pokémon card.
Works on white-mat scans because the art region is inside the yellow border
(pure coloured pixels — anomalies show as linear discontinuities in hue/luma).

Algorithm:
  1. Extract the art region (inside the yellow print frame, with small inset).
  2. Convert to grayscale + enhance local contrast (CLAHE).
  3. Canny edge detection.
  4. Hough line transform — find long straight lines in the detected edges.
  5. Scratch metric: count of long (>5% of card diagonal) near-straight line segments
     that aren't aligned with natural art edges.
  6. Print-line metric: FFT spectral analysis — horizontal banding shows as
     strong mid-frequency peaks in the row-sum vs vertical-sum ratio.

Output:
  scratch_count        count of scratch-candidate lines
  scratch_density      normalized count per 10k px^2 of art area
  print_line_score     0..1 (1 = clean, 0 = heavy banding)
  surface_score        0..1 overall
  psa_ceiling          via PSA-like thresholds
  confidence           0..1, reflects how much of art was analysable

Usage:
    python3 surface.py --image card.jpg [--json-out result.json] [--debug-viz debug.png]
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
from utils import find_outer_card, find_inner_print_frame, extract_art_region

METHOD_VERSION = "surface.v1"

# PSA-style thresholds for surface (min score → grade ceiling)
PSA_THRESHOLDS = [
    (0.95, 10),
    (0.88, 9),
    (0.80, 8),
    (0.70, 7),
    (0.60, 6),
    (0.50, 5),
    (0.40, 4),
    (0.30, 3),
    (0.00, 1),
]


def psa_ceiling(score: float) -> int:
    for threshold, grade in PSA_THRESHOLDS:
        if score >= threshold:
            return grade
    return 1


@dataclass
class SurfaceResult:
    art_size_px: dict
    scratch_count: int
    scratch_total_length_px: int
    scratch_density: float   # scratches per 10k px^2
    print_line_score: float  # 1 = clean, 0 = heavy banding
    surface_score: float     # overall 0..1
    psa_ceiling: int
    confidence: float
    method_version: str
    notes: list


def detect_scratches(art: np.ndarray) -> tuple[int, int, list]:
    """Detect long straight edge segments that look like scratches.

    Returns (count, total_length_px, debug_line_list)
    """
    h, w = art.shape[:2]
    gray = cv2.cvtColor(art, cv2.COLOR_BGR2GRAY) if art.ndim == 3 else art

    # Enhance local contrast
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(16, 16))
    enhanced = clahe.apply(gray)

    # Bilateral filter — preserves edges, suppresses texture
    smoothed = cv2.bilateralFilter(enhanced, 9, 75, 75)

    # Canny — tuned for thin linear features
    edges = cv2.Canny(smoothed, 30, 90)

    # Hough line detection
    diagonal = int(np.hypot(h, w))
    min_length = max(20, int(diagonal * 0.05))  # at least 5% of diagonal
    max_gap = max(4, int(diagonal * 0.005))

    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180, threshold=40,
        minLineLength=min_length, maxLineGap=max_gap,
    )

    if lines is None:
        return 0, 0, []

    # Filter out lines aligned with image borders (top/bottom/left/right 2% strip)
    # — those are usually inner-frame bleed, not scratches.
    border_band = max(5, int(min(h, w) * 0.02))
    scratch_lines = []
    total_length = 0
    for line in lines[:, 0]:
        x1, y1, x2, y2 = line
        # Reject near-border lines
        if (min(x1, x2) < border_band or max(x1, x2) > w - border_band or
                min(y1, y2) < border_band or max(y1, y2) > h - border_band):
            continue
        length = int(np.hypot(x2 - x1, y2 - y1))
        scratch_lines.append((x1, y1, x2, y2, length))
        total_length += length

    return len(scratch_lines), total_length, scratch_lines


def detect_print_lines(art: np.ndarray) -> float:
    """FFT-based print-line detection.

    Print-line defects show as regular horizontal or vertical bands. We detrend
    the image and examine the FFT of row-means and column-means for peaks in
    the banding-frequency range.

    Score: 1.0 = clean, 0.0 = heavy banding.
    """
    gray = cv2.cvtColor(art, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h, w = gray.shape

    # Detrend — subtract blurred version (removes low-freq content = natural art gradients)
    blurred = cv2.GaussianBlur(gray, (0, 0), sigmaX=40, sigmaY=40)
    detrended = gray - blurred

    # Row-means and column-means of the detrended signal
    row_means = detrended.mean(axis=1)
    col_means = detrended.mean(axis=0)

    # FFT — look for peaks in mid-frequency range
    row_fft = np.abs(np.fft.rfft(row_means))
    col_fft = np.abs(np.fft.rfft(col_means))

    # Banding appears at 10-250 cycles per card-height (fine-grained print lines
    # can be very high frequency). The signal is a prominent peak RELATIVE TO
    # the noise floor in that band.
    def band_peak_ratio(fft, h):
        low = 5
        high = min(250, len(fft))
        if high <= low + 5:
            return 0.0
        band = fft[low:high]
        peak = band.max()
        mean = band.mean() + 1e-6
        return float(peak / mean)

    row_ratio = band_peak_ratio(row_fft, h)
    col_ratio = band_peak_ratio(col_fft, w)
    max_ratio = max(row_ratio, col_ratio)

    # Clean art: peak/mean ratio ~2-4. Banding: 8-20.
    # Score = 1.0 if ratio <= 4, 0.0 if ratio >= 15, linear in between.
    if max_ratio <= 4.0:
        return 1.0
    if max_ratio >= 15.0:
        return 0.0
    return float(1.0 - (max_ratio - 4.0) / 11.0)


def measure_surface(image_path: str) -> SurfaceResult:
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    outer = find_outer_card(img)
    notes = []

    try:
        art = extract_art_region(img, outer)
    except RuntimeError as e:
        notes.append(f"art extraction failed: {e} — falling back to full-card minus 10% margin")
        ox0, oy0, ox1, oy1 = outer
        margin_w = int((ox1 - ox0) * 0.10)
        margin_h = int((oy1 - oy0) * 0.10)
        art = img[oy0 + margin_h : oy1 - margin_h, ox0 + margin_w : ox1 - margin_w]
        confidence_base = 0.6
    else:
        confidence_base = 0.95

    ah, aw = art.shape[:2]
    if ah < 100 or aw < 100:
        raise RuntimeError(f"art region too small: {aw}x{ah}")

    scratch_count, scratch_total, _scratch_lines = detect_scratches(art)
    print_line_score = detect_print_lines(art)

    # Scratch density — per 10k px^2 of art area
    art_area = ah * aw
    density = scratch_count / (art_area / 10000.0)

    # Scratch sub-score: 1.0 if no scratches, falls steeply as density rises.
    # Empirically: density 0.01 = a couple of scratches; 0.05 = clearly damaged;
    # 0.1+ = heavily scratched.
    scratch_score = float(np.clip(1.0 - density / 0.08, 0.0, 1.0))

    # Overall: weighted average
    surface_score = 0.65 * scratch_score + 0.35 * print_line_score

    ceiling = psa_ceiling(surface_score)
    confidence = confidence_base

    if surface_score < 0.7:
        notes.append(f"surface quality below PSA 7 ceiling — recommend manual review")

    return SurfaceResult(
        art_size_px={"w": aw, "h": ah},
        scratch_count=scratch_count,
        scratch_total_length_px=scratch_total,
        scratch_density=round(density, 3),
        print_line_score=round(print_line_score, 3),
        surface_score=round(surface_score, 3),
        psa_ceiling=ceiling,
        confidence=round(confidence, 3),
        method_version=METHOD_VERSION,
        notes=notes,
    )


def write_debug_viz(image_path: str, result: SurfaceResult, out_path: str) -> None:
    img = cv2.imread(image_path)
    H, W = img.shape[:2]
    outer = find_outer_card(img)
    try:
        frame = find_inner_print_frame(img, outer)
        cv2.rectangle(img, (frame[0], frame[1]), (frame[2], frame[3]), (0, 255, 0), 3)
    except RuntimeError:
        pass

    try:
        art = extract_art_region(img, outer)
        _, _, lines = detect_scratches(art)
        # Offset lines back to full-image coords
        frame = find_inner_print_frame(img, outer)
        inset = int(min(frame[2] - frame[0], frame[3] - frame[1]) * 0.04)
        ox = frame[0] + inset
        oy = frame[1] + inset
        for x1, y1, x2, y2, _len in lines:
            cv2.line(img, (ox + x1, oy + y1), (ox + x2, oy + y2), (0, 0, 255), 3)
    except Exception:
        pass

    font = cv2.FONT_HERSHEY_SIMPLEX
    lines = [
        f"scratches: {result.scratch_count} (density {result.scratch_density})",
        f"print_line_score: {result.print_line_score}",
        f"surface_score: {result.surface_score}  PSA ceiling: {result.psa_ceiling}",
        f"confidence: {result.confidence}",
    ]
    y = 50
    for line in lines:
        cv2.putText(img, line, (20, y), font, 0.9, (255, 255, 255), 4)
        cv2.putText(img, line, (20, y), font, 0.9, (0, 0, 255), 2)
        y += 40
    cv2.imwrite(out_path, img)


def main():
    parser = argparse.ArgumentParser(description="Measure surface defects in the art region of an aligned card scan.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--json-out")
    parser.add_argument("--debug-viz")
    args = parser.parse_args()

    try:
        result = measure_surface(args.image)
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
