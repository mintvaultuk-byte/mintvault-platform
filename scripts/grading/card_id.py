#!/usr/bin/env python3
"""
MintVault card identification via OCR.

Extracts the bottom strip of an aligned card scan, runs Tesseract over it,
parses the structured card-number + set + copyright fields via regex, and
cross-references against a bundled local Pokémon set database.

Usage:
    python3 card_id.py --image card.jpg
    python3 card_id.py --image card.jpg --json-out result.json
    python3 card_id.py --image card.jpg --debug-viz debug.png

Output fields:
    card_number:       "058/165" or None
    number:            58           (int, from card_number)
    total:             165          (int, from card_number)
    set_code_raw:      "SV01"       (OCR-extracted, may be noisy)
    set:               {code, name, year, series, total_cards} or None
    copyright_year:    2023 or None
    regulation_mark:   "F" / "G" / "H" or None
    raw_ocr:           full OCR text (for debugging)
    field_confidences: per-field 0..1
    confidence:        overall, product of per-field confidences
    method_version:    string
    notes:             list of flags

Replaces the AI call for "identify this card" — runs locally, no API cost.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import pytesseract

sys.path.insert(0, str(Path(__file__).parent))
from utils import find_outer_card, extract_bottom_strip, load_set_db, resolve_set_code

METHOD_VERSION = "card_id.v1"

# Regex patterns for the structured fields.
# Card number: "NNN/TTT" where NNN is 1-3 digits, TTT is 1-3 digits. Also accept forms like "058/165" or "8/102"
CARD_NUMBER_RE = re.compile(r"\b(\d{1,3})\s*/\s*(\d{1,3})\b")
# Copyright: "©YYYY", "(c) YYYY", "Pokémon YYYY", or a standalone 4-digit year in range.
# Accept OCR-munged variants (Tesseract on small text commonly misreads "Pokemon" → "votemon" etc).
COPYRIGHT_YEAR_RE = re.compile(
    r"(?:©|\(c\)|pokem[oa]n|votemon|nintendo|creatures|game\s*freak)\s*[- ]?\s*(\d{4})"
    r"|(?:^|\s|-)((?:19|20)\d{2})(?=\s|$|[^\d])",
    re.IGNORECASE,
)
# Regulation mark: single letter on its own (recent cards)
# Pattern: isolated single uppercase letter, often before card number, common letters: D, E, F, G, H
REGULATION_RE = re.compile(r"(?:^|\s)([DEFGH])(?=\s|$)")
# Set code: 2-5 chars (letters and digits), OCR may produce lowercase.
SET_CODE_RE = re.compile(r"\b([a-zA-Z]{2,5}[0-9]{0,2}|[a-zA-Z]{1,3}[0-9]{1,3})\b")


def preprocess_for_ocr(strip: np.ndarray) -> np.ndarray:
    """Preprocess the bottom strip to maximise Tesseract accuracy.

    Pokémon card bottom text is typically small, dark, on light background.
    Upscale + sharpen + binarise.
    """
    h, w = strip.shape[:2]
    # Upscale so text is at least 20px tall
    target_h = max(h, 200)
    scale = target_h / h
    if scale > 1.0:
        strip = cv2.resize(strip, (int(w * scale), target_h), interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY) if strip.ndim == 3 else strip
    # Adaptive threshold handles colour-border bleed better than Otsu here
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10
    )
    # Slight denoise
    binary = cv2.medianBlur(binary, 3)
    return binary


@dataclass
class CardIDResult:
    card_number: Optional[str]
    number: Optional[int]
    total: Optional[int]
    set_code_raw: Optional[str]
    set: Optional[dict]
    copyright_year: Optional[int]
    regulation_mark: Optional[str]
    raw_ocr: str
    field_confidences: dict
    confidence: float
    method_version: str
    notes: list


def parse_card_number(ocr: str) -> tuple[Optional[str], Optional[int], Optional[int], float]:
    # Normalise common OCR confusions: O→0 in digit contexts
    cleaned = re.sub(r"(?<=\d)O(?=\d)", "0", ocr)
    cleaned = re.sub(r"O(?=/\d)", "0", cleaned)
    cleaned = re.sub(r"(?<=\d/)O", "0", cleaned)
    m = CARD_NUMBER_RE.search(cleaned)
    if not m:
        return None, None, None, 0.0
    n = int(m.group(1))
    t = int(m.group(2))
    # Sanity: typical totals are 40-350
    if t < 10 or t > 500 or n < 1 or n > t + 50:
        return m.group(0), n, t, 0.3
    # Return the raw matched form — don't impose a format the card didn't have
    # (classic cards use "4/102", modern ones "004/258")
    return m.group(0).replace(" ", ""), n, t, 0.95


def parse_copyright(ocr: str) -> tuple[Optional[int], float]:
    m = COPYRIGHT_YEAR_RE.search(ocr)
    if not m:
        return None, 0.0
    # Either group 1 (named-context year) or group 2 (standalone year) will match
    y_str = m.group(1) or m.group(2)
    if not y_str:
        return None, 0.0
    y = int(y_str)
    if 1996 <= y <= 2035:
        # Higher confidence if matched via named context
        conf = 0.9 if m.group(1) else 0.7
        return y, conf
    return y, 0.3


def detect_regulation_mark(strip: np.ndarray) -> tuple[Optional[str], float]:
    """Regulation marks are a single uppercase letter inside a small filled circle at
    the bottom-left of recent cards. They OCR poorly in the normal pipeline because
    they're inverted (white letter on black). Run a dedicated pass on the left
    portion of the strip with the image inverted.
    """
    h, w = strip.shape[:2]
    # Left 20% of the strip — where the regulation mark lives on modern cards
    roi = strip[:, : max(80, w // 5)]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi
    # Upscale so a ~50px circle becomes ~200px
    gray_up = cv2.resize(gray, (gray.shape[1] * 4, gray.shape[0] * 4), interpolation=cv2.INTER_CUBIC)
    # Invert: black circle with white text → white background with black text
    inverted = 255 - gray_up
    # Binarise
    _, binary = cv2.threshold(inverted, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Restrict to single-char Tesseract pass (PSM 10 = single character)
    cfg = "--psm 10 -c tessedit_char_whitelist=DEFGHIJ"
    try:
        text = pytesseract.image_to_string(binary, config=cfg).strip()
    except Exception:
        return None, 0.0
    # Take the first letter if any
    letters = [c for c in text if c.isalpha() and c.upper() in "DEFGHIJ"]
    if letters:
        return letters[0].upper(), 0.85
    return None, 0.0


def parse_set_code(ocr: str, near_card_number_idx: Optional[int] = None) -> tuple[Optional[str], float]:
    """Attempt to isolate a set code from the OCR text.

    Strategy: look for SET_CODE_RE matches near the card number (if known) first,
    otherwise take the best candidate from the full text.
    """
    matches = list(SET_CODE_RE.finditer(ocr))
    if not matches:
        return None, 0.0
    # If we have a card number position, prefer codes near it
    if near_card_number_idx is not None:
        matches.sort(key=lambda m: abs(m.start() - near_card_number_idx))
    # Filter out common false-positives
    blacklist = {"HP", "LV", "GX", "EX", "VMAX", "VSTAR", "TM", "NO", "POKEMON", "NINTENDO",
                 "CREATURES", "GAMEFREAK", "THE", "AND", "OF", "INC", "LTD", "ALL",
                 "VOTEMON", "OER", "AES", "OO"}  # common OCR munges
    # Prefer high-quality matches: has digit, OR is 3+ chars
    def score_match(m):
        code = m.group(1).upper()
        if code in blacklist:
            return -1
        has_digit = any(c.isdigit() for c in code)
        if has_digit:
            return 10 + len(code)  # digit-containing codes are best
        if len(code) >= 3:
            return 5 + len(code)  # 3+ letter codes second best
        return 1  # 2-letter alphabetic codes are last-resort
    scored = [(score_match(m), m) for m in matches]
    scored = [(s, m) for s, m in scored if s > 0]
    if not scored:
        return None, 0.0
    scored.sort(key=lambda x: -x[0])  # highest score first
    best = scored[0][1]
    return best.group(1).upper(), 0.6 if scored[0][0] >= 10 else 0.4


def identify_card(image_path: str) -> CardIDResult:
    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    outer = find_outer_card(img)
    strip = extract_bottom_strip(img, outer)
    pre = preprocess_for_ocr(strip)

    # Tesseract psm 6 = assume a block of uniform text. Works well for bottom strip.
    raw_ocr = pytesseract.image_to_string(pre, config="--psm 6")
    raw_ocr = raw_ocr.strip()

    notes = []

    # Parse each field
    card_num_str, num, total, num_conf = parse_card_number(raw_ocr)
    copy_year, copy_conf = parse_copyright(raw_ocr)
    reg_mark, reg_conf = detect_regulation_mark(strip)

    # Find card number position in OCR for set-code proximity
    m = CARD_NUMBER_RE.search(raw_ocr)
    num_idx = m.start() if m else None
    set_code_raw, set_conf = parse_set_code(raw_ocr, num_idx)

    # Resolve the set code against the local DB
    set_info = resolve_set_code(set_code_raw) if set_code_raw else None
    if set_code_raw and not set_info:
        notes.append(f"set code '{set_code_raw}' not found in local DB — may need DB update")

    # Sanity cross-check: if copyright year and set year disagree, lower confidence
    if copy_year and set_info and abs(copy_year - set_info.get("year", copy_year)) > 2:
        notes.append(f"copyright year ({copy_year}) and set year ({set_info.get('year')}) disagree — possible OCR error")

    field_confidences = {
        "card_number": round(num_conf, 3),
        "copyright_year": round(copy_conf, 3),
        "regulation_mark": round(reg_conf, 3),
        "set_code": round(set_conf, 3),
    }

    # Overall confidence: weighted average. Card number is the most important field.
    overall = 0.5 * num_conf + 0.2 * copy_conf + 0.1 * reg_conf + 0.2 * set_conf

    if overall < 0.5:
        notes.append(f"low overall confidence ({overall:.2f}) — recommend AI fallback")

    return CardIDResult(
        card_number=card_num_str,
        number=num,
        total=total,
        set_code_raw=set_code_raw,
        set=set_info,
        copyright_year=copy_year,
        regulation_mark=reg_mark,
        raw_ocr=raw_ocr,
        field_confidences=field_confidences,
        confidence=round(overall, 3),
        method_version=METHOD_VERSION,
        notes=notes,
    )


def write_debug_viz(image_path: str, result: CardIDResult, out_path: str) -> None:
    img = cv2.imread(image_path)
    H, W = img.shape[:2]
    outer = find_outer_card(img)
    ox0, oy0, ox1, oy1 = outer
    card_h = oy1 - oy0 + 1
    strip_h = max(60, int(card_h * 0.07))
    y_strip = oy1 - strip_h + 1

    # Draw the bottom strip region
    cv2.rectangle(img, (ox0, y_strip), (ox1, oy1), (0, 255, 0), 3)

    font = cv2.FONT_HERSHEY_SIMPLEX
    y_text = 50
    lines = [
        f"card_number: {result.card_number}",
        f"set_code_raw: {result.set_code_raw}",
        f"set: {result.set['name'] if result.set else 'unresolved'}",
        f"copyright: {result.copyright_year}",
        f"regulation: {result.regulation_mark}",
        f"confidence: {result.confidence}",
    ]
    for line in lines:
        cv2.putText(img, line, (20, y_text), font, 0.9, (255, 255, 255), 4)
        cv2.putText(img, line, (20, y_text), font, 0.9, (0, 0, 255), 2)
        y_text += 40
    cv2.imwrite(out_path, img)


def main():
    parser = argparse.ArgumentParser(description="Identify a Pokémon card from an aligned scan via OCR.")
    parser.add_argument("--image", required=True)
    parser.add_argument("--json-out")
    parser.add_argument("--debug-viz")
    args = parser.parse_args()

    try:
        result = identify_card(args.image)
    except Exception as e:
        err = {"error": str(e), "method_version": METHOD_VERSION}
        print(json.dumps(err), file=sys.stderr)
        sys.exit(1)

    payload = json.dumps(asdict(result), indent=2, ensure_ascii=False)
    if args.json_out:
        Path(args.json_out).write_text(payload)
    else:
        print(payload)
    if args.debug_viz:
        write_debug_viz(args.image, result, args.debug_viz)


if __name__ == "__main__":
    main()
