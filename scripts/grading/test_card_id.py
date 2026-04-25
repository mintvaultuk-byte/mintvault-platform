#!/usr/bin/env python3
"""
Synthesize Pokémon-card fixtures with known bottom-strip content and verify
card_id.py recovers the expected fields.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Re-use base card generator from centering tests, but add a bottom-strip with text
CARD_H = 3355
CARD_W = int(CARD_H * 0.716)
YELLOW_HSV = (30, 200, 230)
BACKGROUND = 255


def _find_font(size: int) -> ImageFont.FreeTypeFont:
    """Try several common fonts; fall back to default."""
    candidates = [
        "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",  # monospace is best for card numbers
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for c in candidates:
        if Path(c).exists():
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def make_fixture(
    out_path: str,
    card_number: str = "058/165",
    set_code: str = "MEW",
    copyright_year: int = 2023,
    regulation_mark: str = "F",
    bottom_layout: str = "modern",  # "modern" or "classic"
) -> None:
    """Generate a fake card with a realistic bottom strip."""
    img = np.full((CARD_H, CARD_W, 3), BACKGROUND, dtype=np.uint8)
    # Yellow border
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hsv[100 : CARD_H - 100, 100 : CARD_W - 100] = YELLOW_HSV
    img = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    # Art region (inside yellow)
    cv2.rectangle(img, (160, 160), (CARD_W - 160, int(CARD_H * 0.55)), (60, 80, 100), thickness=-1)
    # White text-area band below the art inside the yellow frame
    cv2.rectangle(img, (160, int(CARD_H * 0.55)), (CARD_W - 160, CARD_H - 160),
                  (255, 255, 255), thickness=-1)

    # Render the bottom strip text onto the bottom portion of the white area,
    # in realistic positions. Use PIL for real font rendering.
    pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil_img)

    # Card number text (bottom-right typically on modern cards)
    number_font = _find_font(48)
    small_font = _find_font(32)

    bottom_y = CARD_H - 220
    if bottom_layout == "modern":
        # Left: regulation mark in a small filled circle — positioned WELL LEFT, separate from number
        if regulation_mark:
            rx, ry = 180, bottom_y + 5
            draw.ellipse((rx, ry, rx + 60, ry + 60), fill="black")
            # Render the letter centred in the circle
            bbox = draw.textbbox((0, 0), regulation_mark, font=number_font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.text((rx + 30 - tw // 2, ry + 30 - th // 2 - 4), regulation_mark,
                      fill="white", font=number_font)
        # Middle-left: set code (with clear horizontal gap from regulation mark)
        draw.text((310, bottom_y + 12), set_code, fill="black", font=small_font)
        # Middle: card number (further right, clearly separated)
        draw.text((520, bottom_y + 12), card_number, fill="black", font=number_font)
        # Right: copyright line
        copy_text = f"(c) {copyright_year} Pokemon"
        copy_bbox = draw.textbbox((0, 0), copy_text, font=small_font)
        cw_text = copy_bbox[2] - copy_bbox[0]
        draw.text((CARD_W - cw_text - 180, bottom_y + 18), copy_text,
                  fill="black", font=small_font)
    else:
        # Classic: card number bottom-right, copyright centered below
        num_bbox = draw.textbbox((0, 0), card_number, font=number_font)
        nw = num_bbox[2] - num_bbox[0]
        draw.text((CARD_W - nw - 200, bottom_y), card_number, fill="black", font=number_font)
        copy_text = f"(c) {copyright_year} Nintendo"
        ct_bbox = draw.textbbox((0, 0), copy_text, font=small_font)
        ctw = ct_bbox[2] - ct_bbox[0]
        draw.text(((CARD_W - ctw) // 2, bottom_y + 70), copy_text,
                  fill="black", font=small_font)

    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    cv2.imwrite(out_path, img)


def run_card_id(image_path: str) -> dict:
    r = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "card_id.py"), "--image", image_path],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"card_id.py failed: {r.stderr}")
    return json.loads(r.stdout)


def describe(name: str, expected: dict, got: dict, strict: bool = False) -> bool:
    """Test expectations.

    Primary checks (required to pass): number, total, copyright_year
    Advisory checks (logged, do not fail in non-strict mode):
      card_number string form (OCR may lose leading zeros)
      regulation_mark (depends on small circle OCR quality)
      set_name resolution (OCR on tiny set codes is hardest)
    """
    print(f"\n=== {name} ===")
    print(f"  Raw OCR: {got['raw_ocr']!r}")

    primary_keys = {"number", "total", "copyright_year"}
    advisory_keys = {"card_number", "regulation_mark", "set_name"}

    primary_ok = True
    for field in primary_keys:
        if field not in expected:
            continue
        ev = expected[field]
        gv = got.get(field)
        ok = (ev is None and gv is None) or (ev == gv)
        status = "✓" if ok else "✗"
        print(f"  {status} [primary] {field}: expected={ev!r} got={gv!r}")
        if not ok:
            primary_ok = False

    # Advisory
    for field in advisory_keys:
        if field not in expected:
            continue
        ev = expected[field]
        if field == "set_name":
            gv = got.get("set", {}).get("name") if got.get("set") else None
        else:
            gv = got.get(field)
        ok = (ev is None and gv is None) or (ev == gv)
        status = "✓" if ok else "·"
        print(f"  {status} [advisory] {field}: expected={ev!r} got={gv!r}")
        if strict and not ok:
            primary_ok = False

    print(f"  confidence: {got['confidence']}")
    print(f"  field_confidences: {got['field_confidences']}")
    print(f"  {'✓ PASS' if primary_ok else '✗ FAIL'}")
    return primary_ok


def main():
    Path("/tmp/card-id-fixtures").mkdir(exist_ok=True)
    all_pass = True

    # Test 1: modern Scarlet & Violet 151 card
    p = "/tmp/card-id-fixtures/t1-modern-151.png"
    make_fixture(p, "058/165", "MEW", 2023, "F", "modern")
    got = run_card_id(p)
    all_pass &= describe("Test 1 — modern SV 151 card",
                          {"card_number": "058/165", "number": 58, "total": 165,
                           "copyright_year": 2023, "regulation_mark": "F"},
                          got)

    # Test 2: modern SV Paldea Evolved
    p = "/tmp/card-id-fixtures/t2-modern-paldea.png"
    make_fixture(p, "193/279", "SV02", 2023, "G", "modern")
    got = run_card_id(p)
    all_pass &= describe("Test 2 — SV02 Paldea Evolved",
                          {"card_number": "193/279", "number": 193, "total": 279,
                           "copyright_year": 2023, "regulation_mark": "G"},
                          got)

    # Test 3: classic Base Set layout (note: fixture renders number as-is, OCR will read "4/102")
    p = "/tmp/card-id-fixtures/t3-classic-base.png"
    make_fixture(p, "4/102", "BS", 1999, "", "classic")
    got = run_card_id(p)
    all_pass &= describe("Test 3 — classic Base Set Charizard-style",
                          {"card_number": "4/102", "number": 4, "total": 102,
                           "copyright_year": 1999},
                          got)

    # Test 4: 3-digit total over 100
    p = "/tmp/card-id-fixtures/t4-high-number.png"
    make_fixture(p, "215/230", "SV03", 2023, "G", "modern")
    got = run_card_id(p)
    all_pass &= describe("Test 4 — high card number in 230-card set",
                          {"card_number": "215/230", "number": 215, "total": 230,
                           "copyright_year": 2023, "regulation_mark": "G"},
                          got)

    # Test 5: single-digit card number
    p = "/tmp/card-id-fixtures/t5-single-digit.png"
    make_fixture(p, "007/165", "MEW", 2023, "F", "modern")
    got = run_card_id(p)
    all_pass &= describe("Test 5 — zero-padded single-digit card number",
                          {"card_number": "007/165", "number": 7, "total": 165,
                           "copyright_year": 2023, "regulation_mark": "F"},
                          got)

    # Test 6: set DB resolution check
    p = "/tmp/card-id-fixtures/t6-resolved-set.png"
    make_fixture(p, "100/258", "SV01", 2023, "F", "modern")
    got = run_card_id(p)
    ok_set = got.get("set") and got["set"].get("name") == "Scarlet & Violet"
    print(f"\n=== Test 6 — set DB resolution ===")
    print(f"  Expected: set resolves to 'Scarlet & Violet'")
    print(f"  Got set: {got.get('set')}")
    print(f"  {'✓ PASS' if ok_set else '✗ FAIL (set not resolved)'}")
    all_pass &= bool(ok_set)

    print("\n" + "=" * 60)
    print(f"{'CARD_ID TESTS PASS ✓' if all_pass else 'CARD_ID TESTS FAIL ✗'}")
    print("=" * 60)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
