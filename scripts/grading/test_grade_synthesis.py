#!/usr/bin/env python3
"""Tests for grade_synthesis.py."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

OUT_DIR = Path("/tmp/synthesis-fixtures")
OUT_DIR.mkdir(exist_ok=True)


def write_fixture(name: str, data: dict) -> str:
    p = OUT_DIR / name
    p.write_text(json.dumps(data))
    return str(p)


def run_synth(**kwargs) -> dict:
    cmd = [sys.executable, str(Path(__file__).parent / "grade_synthesis.py")]
    for k, v in kwargs.items():
        if v is None:
            continue
        cmd += [f"--{k.replace('_', '-')}", str(v)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"grade_synthesis.py failed: {r.stderr}")
    return json.loads(r.stdout)


def describe(name: str, expected_grade: int, expected_limit: str, got: dict) -> bool:
    passed = (got["proposed_grade"] == expected_grade and got["limiting_factor"] == expected_limit)
    print(f"\n=== {name} ===")
    print(f"  proposed_grade: {got['proposed_grade']} (expected {expected_grade})")
    print(f"  limiting_factor: {got['limiting_factor']} (expected {expected_limit})")
    print(f"  confidence: {got['confidence']}")
    print(f"  reasoning: {got['reasoning'][:120]}...")
    print(f"  {'✓ PASS' if passed else '✗ FAIL'}")
    return passed


def main():
    all_pass = True

    centering_10 = {"psa_ceiling": 10, "confidence": 0.95, "display": {"horizontal": "50/50", "vertical": "50/50"}}
    centering_8 = {"psa_ceiling": 8, "confidence": 0.90, "display": {"horizontal": "65/35", "vertical": "55/45"}}
    centering_6 = {"psa_ceiling": 6, "confidence": 0.85, "display": {"horizontal": "75/25", "vertical": "60/40"}}

    surface_10 = {"psa_ceiling": 10, "confidence": 0.95, "scratch_count": 0, "surface_score": 0.98}
    surface_7 = {"psa_ceiling": 7, "confidence": 0.90, "scratch_count": 15, "surface_score": 0.72}
    surface_4 = {"psa_ceiling": 4, "confidence": 0.95, "scratch_count": 80, "surface_score": 0.42}

    miscut_perfect = {"classification": "perfect", "confidence": 0.95, "worst_cov": 0.01}
    miscut_miscut = {"classification": "miscut", "confidence": 0.95, "worst_cov": 0.35}

    # Test 1: everything perfect + AI says corners/edges both 10 → PSA 10
    cent = write_fixture("cent_10.json", centering_10)
    surf = write_fixture("surf_10.json", surface_10)
    misc = write_fixture("misc_perfect.json", miscut_perfect)
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=10, ai_edges_grade=10)
    all_pass &= describe("Test 1 — all ceilings 10 → PSA 10", 10, "centering", got)

    # Test 2: centering 8, everything else 10 → PSA 8 limited by centering
    cent = write_fixture("cent_8.json", centering_8)
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=10, ai_edges_grade=10)
    all_pass &= describe("Test 2 — centering 8 pins → PSA 8", 8, "centering", got)

    # Test 3: surface 4 is the floor
    surf = write_fixture("surf_4.json", surface_4)
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=10, ai_edges_grade=10)
    all_pass &= describe("Test 3 — surface 4 pins (heavily scratched)", 4, "surface", got)

    # Test 4: miscut caps at 4 even when sub-grades are high
    cent = write_fixture("cent_10.json", centering_10)
    surf = write_fixture("surf_10.json", surface_10)
    misc = write_fixture("misc_miscut.json", miscut_miscut)
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=10, ai_edges_grade=10)
    all_pass &= describe("Test 4 — miscut classification → PSA 4 cap", 4, "miscut", got)

    # Test 5: AI-derived corners pins the grade
    misc = write_fixture("misc_perfect.json", miscut_perfect)
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=6, ai_edges_grade=10)
    all_pass &= describe("Test 5 — AI corners=6 pins → PSA 6", 6, "corners", got)

    # Test 6: AI-derived edges pins the grade
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=9, ai_edges_grade=5)
    all_pass &= describe("Test 6 — AI edges=5 pins → PSA 5", 5, "edges", got)

    # Test 7: mix — centering=8, surface=7, corners=9 → min is surface=7
    cent = write_fixture("cent_8.json", centering_8)
    surf = write_fixture("surf_7.json", surface_7)
    got = run_synth(centering_json=cent, surface_json=surf, miscut_json=misc,
                    ai_corners_grade=9, ai_edges_grade=10)
    all_pass &= describe("Test 7 — realistic mix → PSA 7 limited by surface", 7, "surface", got)

    # Test 8: missing miscut data — should still work, centering 6 limits
    cent = write_fixture("cent_6.json", centering_6)
    got = run_synth(centering_json=cent, surface_json=surf,
                    ai_corners_grade=10, ai_edges_grade=10)
    all_pass &= describe("Test 8 — no miscut data, centering 6 limits → PSA 6", 6, "centering", got)

    print("\n" + "=" * 50)
    print(f"{'SYNTHESIS TESTS PASS ✓' if all_pass else 'SYNTHESIS TESTS FAIL ✗'}")
    print("=" * 50)
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
