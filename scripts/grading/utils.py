"""
Shared utilities for MintVault grading CV modules.

- find_outer_card: bounding box of the card in a scanner output (matches centering.py)
- extract_bottom_strip: bottom 7% of the card (where card-number, set symbol, copyright live)
- extract_art_region: the interior of the coloured (yellow on Pokémon) print frame
- load_set_db: load the local set-code JSON bundled alongside this package
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import cv2
import numpy as np


DATA_DIR = Path(__file__).parent / "data"


def find_outer_card(img: np.ndarray) -> tuple[int, int, int, int]:
    """Locate the outer card boundary. Returns (x0, y0, x1, y1) inclusive.

    Matches the algorithm used in centering.py: assumes scanner pipeline has
    already cropped tight to the card, but handles the case where residual
    background is present.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    white_frac = np.mean(thresh > 0)
    if white_frac > 0.95:
        return 0, 0, w - 1, h - 1
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0, 0, w - 1, h - 1
    c = max(contours, key=cv2.contourArea)
    x, y, cw, ch = cv2.boundingRect(c)
    return x, y, x + cw - 1, y + ch - 1


def find_inner_print_frame(img: np.ndarray, outer: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Detect the inner print frame (yellow border on Pokémon cards).

    Returns (x0, y0, x1, y1) inclusive — the bounding box of the coloured print area.
    Raises RuntimeError if the yellow border isn't detectable.

    Uses the same sat-threshold logic as centering.py but returns a bbox rather
    than per-edge measurements.
    """
    ox0, oy0, ox1, oy1 = outer
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]

    def first_above(arr, threshold=40, start=5):
        idx = np.argmax(arr[start:] >= threshold)
        return start + idx if arr[start + idx] >= threshold else None

    # Sample from each side using multiple lines, take median
    sample_count = 21

    samples_x = np.linspace(ox0 + (ox1 - ox0) * 0.15, ox0 + (ox1 - ox0) * 0.85, sample_count).astype(int)
    samples_y = np.linspace(oy0 + (oy1 - oy0) * 0.15, oy0 + (oy1 - oy0) * 0.85, sample_count).astype(int)

    tops = []
    for sx in samples_x:
        col = sat[oy0 : oy1 + 1, sx]
        idx = first_above(col)
        if idx is not None:
            tops.append(oy0 + idx)
    bottoms = []
    for sx in samples_x:
        col = sat[oy0 : oy1 + 1, sx][::-1]
        idx = first_above(col)
        if idx is not None:
            bottoms.append(oy1 - idx)
    lefts = []
    for sy in samples_y:
        row = sat[sy, ox0 : ox1 + 1]
        idx = first_above(row)
        if idx is not None:
            lefts.append(ox0 + idx)
    rights = []
    for sy in samples_y:
        row = sat[sy, ox0 : ox1 + 1][::-1]
        idx = first_above(row)
        if idx is not None:
            rights.append(ox1 - idx)

    if not (tops and bottoms and lefts and rights):
        raise RuntimeError("inner print frame not detectable on one or more sides")

    return int(np.median(lefts)), int(np.median(tops)), int(np.median(rights)), int(np.median(bottoms))


def extract_bottom_strip(img: np.ndarray, outer: tuple[int, int, int, int],
                         strip_frac: float = 0.07) -> np.ndarray:
    """Extract the bottom strip of the card where the card-number, set symbol
    and copyright live. Default height is 7% of card height.
    """
    ox0, oy0, ox1, oy1 = outer
    card_h = oy1 - oy0 + 1
    strip_h = max(60, int(card_h * strip_frac))
    return img[oy1 - strip_h + 1 : oy1 + 1, ox0 : ox1 + 1]


def extract_art_region(img: np.ndarray, outer: tuple[int, int, int, int],
                       inset_frac: float = 0.04) -> np.ndarray:
    """Extract the interior art region — inside the inner print frame, with a
    small additional inset to avoid edge contamination.
    """
    frame = find_inner_print_frame(img, outer)
    fx0, fy0, fx1, fy1 = frame
    inset = int(min(fx1 - fx0, fy1 - fy0) * inset_frac)
    return img[fy0 + inset : fy1 - inset, fx0 + inset : fx1 - inset]


def load_set_db() -> dict:
    """Load the bundled set-code database.

    Returns {set_code: {"name": str, "year": int, "series": str, "total_cards": int, "aliases": [str]}}
    """
    path = DATA_DIR / "pokemon_sets.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def resolve_set_code(raw: str, db: Optional[dict] = None) -> Optional[dict]:
    """Given an OCR-extracted set code (e.g. "SV01", "BAS", "PAL"), look up full info.

    Tries exact match first, then aliases.
    """
    if db is None:
        db = load_set_db()
    if not raw:
        return None
    raw_u = raw.upper().strip()
    if raw_u in db:
        return {"code": raw_u, **db[raw_u]}
    for code, info in db.items():
        if raw_u in [a.upper() for a in info.get("aliases", [])]:
            return {"code": code, **info}
    return None
