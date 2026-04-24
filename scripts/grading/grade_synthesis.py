#!/usr/bin/env python3
"""
MintVault grade synthesis.

Takes the outputs of the individual CV sub-grade modules (centering.py,
surface.py, miscut.py) and combines them into a proposed overall PSA-style
grade with confidence + reasoning.

Corners and edges remain AI-dependent on white-mat scans (they cannot be
measured deterministically without a dark mat — see project docs).

Inputs (all optional):
    --centering-json   path to centering.py --json-out output
    --surface-json     path to surface.py --json-out output
    --miscut-json      path to miscut.py --json-out output
    --ai-corners-grade integer PSA grade for corners sub-grade from AI fallback
    --ai-edges-grade   integer PSA grade for edges sub-grade from AI fallback

Output:
    proposed_grade      int (1-10)
    component_ceilings  per-sub-grade PSA ceilings with source (cv or ai)
    limiting_factor     which sub-grade pinned the final grade
    confidence          overall 0..1 — low if any CV confidence was low or AI fallback used
    reasoning           human-readable explanation
    method_version

PSA overall grade is typically min of the four sub-grades, adjusted by a small
bonus for cards where all four are near-perfect. We follow that convention.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

METHOD_VERSION = "grade_synthesis.v1"


@dataclass
class ComponentCeiling:
    name: str
    ceiling: int
    source: str        # "cv" or "ai" or "missing"
    confidence: float
    detail: str = ""


@dataclass
class SynthesisResult:
    proposed_grade: int
    component_ceilings: list
    limiting_factor: str
    confidence: float
    reasoning: str
    method_version: str
    notes: list


def load_optional(path: Optional[str]) -> Optional[dict]:
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def synthesise(
    centering: Optional[dict],
    surface: Optional[dict],
    miscut: Optional[dict],
    ai_corners_grade: Optional[int],
    ai_edges_grade: Optional[int],
) -> SynthesisResult:
    components: list[ComponentCeiling] = []
    notes: list[str] = []

    # Centering
    if centering:
        components.append(ComponentCeiling(
            name="centering",
            ceiling=centering.get("psa_ceiling", 1),
            source="cv",
            confidence=centering.get("confidence", 0.0),
            detail=f"H {centering.get('display', {}).get('horizontal', '?')}  V {centering.get('display', {}).get('vertical', '?')}",
        ))
    else:
        components.append(ComponentCeiling(name="centering", ceiling=10, source="missing",
                                           confidence=0.0, detail="no centering data"))
        notes.append("centering data missing — effectively unrestricted")

    # Surface
    if surface:
        components.append(ComponentCeiling(
            name="surface",
            ceiling=surface.get("psa_ceiling", 1),
            source="cv",
            confidence=surface.get("confidence", 0.0),
            detail=f"{surface.get('scratch_count', '?')} scratches  surface_score={surface.get('surface_score', '?')}",
        ))
    else:
        components.append(ComponentCeiling(name="surface", ceiling=10, source="missing",
                                           confidence=0.0, detail="no surface data"))
        notes.append("surface data missing — effectively unrestricted")

    # Miscut — only pins the grade if classified as 'noticeable' or 'miscut'
    # (perfect/slight miscut is normal print variation and doesn't cap grade)
    if miscut:
        cls = miscut.get("classification", "perfect")
        miscut_ceiling_map = {"perfect": 10, "slight": 10, "noticeable": 7, "miscut": 4}
        ceiling = miscut_ceiling_map.get(cls, 10)
        components.append(ComponentCeiling(
            name="miscut",
            ceiling=ceiling,
            source="cv",
            confidence=miscut.get("confidence", 0.0),
            detail=f"classification: {cls}  worst_cov={miscut.get('worst_cov', '?')}",
        ))
        if cls in ("noticeable", "miscut"):
            notes.append(f"miscut detected ({cls}) — treating as cap at PSA {ceiling}")
    else:
        components.append(ComponentCeiling(name="miscut", ceiling=10, source="missing",
                                           confidence=0.0, detail="no miscut data"))

    # Corners — AI-dependent on white mat
    if ai_corners_grade is not None:
        components.append(ComponentCeiling(
            name="corners", ceiling=ai_corners_grade, source="ai",
            confidence=0.75, detail="from AI fallback (white-mat limitation)",
        ))
    else:
        components.append(ComponentCeiling(
            name="corners", ceiling=10, source="missing",
            confidence=0.0, detail="no corners data (AI or CV)",
        ))
        notes.append("corners data missing — grade will not be conservative on corner damage")

    # Edges — AI-dependent on white mat
    if ai_edges_grade is not None:
        components.append(ComponentCeiling(
            name="edges", ceiling=ai_edges_grade, source="ai",
            confidence=0.75, detail="from AI fallback (white-mat limitation)",
        ))
    else:
        components.append(ComponentCeiling(
            name="edges", ceiling=10, source="missing",
            confidence=0.0, detail="no edges data (AI or CV)",
        ))
        notes.append("edges data missing — grade will not be conservative on edge damage")

    # PSA rule: overall grade = min of sub-grades (no bonus unless all near-perfect)
    ceilings = [(c.name, c.ceiling) for c in components if c.source != "missing"]
    if not ceilings:
        raise RuntimeError("No sub-grade data supplied — cannot synthesise")

    limiting = min(ceilings, key=lambda x: x[1])
    base_grade = limiting[1]
    limiting_factor = limiting[0]

    # Gem-mint bonus: if all sub-grades from CV are 10 and confidence is high, allow PSA 10.
    # Otherwise cap at the minimum.
    all_cv_ten = all(c.ceiling == 10 for c in components if c.source == "cv")
    cv_confidence = [c.confidence for c in components if c.source == "cv"]

    # Overall confidence = minimum of all involved confidences (most pessimistic)
    all_confidences = [c.confidence for c in components if c.source != "missing"]
    overall_conf = min(all_confidences) if all_confidences else 0.0

    reasoning_parts = []
    for c in components:
        reasoning_parts.append(f"{c.name}={c.ceiling} [{c.source}, conf {c.confidence:.2f}]")
    reasoning = "; ".join(reasoning_parts) + f". Limiting factor: {limiting_factor}."

    if overall_conf < 0.65:
        notes.append(f"overall confidence low ({overall_conf:.2f}) — recommend human reviewer")

    return SynthesisResult(
        proposed_grade=base_grade,
        component_ceilings=[asdict(c) for c in components],
        limiting_factor=limiting_factor,
        confidence=round(overall_conf, 3),
        reasoning=reasoning,
        method_version=METHOD_VERSION,
        notes=notes,
    )


def main():
    parser = argparse.ArgumentParser(description="Synthesise final PSA grade from sub-grade module outputs.")
    parser.add_argument("--centering-json")
    parser.add_argument("--surface-json")
    parser.add_argument("--miscut-json")
    parser.add_argument("--ai-corners-grade", type=int, help="AI-derived corners sub-grade (1-10)")
    parser.add_argument("--ai-edges-grade", type=int, help="AI-derived edges sub-grade (1-10)")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    centering = load_optional(args.centering_json)
    surface = load_optional(args.surface_json)
    miscut = load_optional(args.miscut_json)

    try:
        result = synthesise(centering, surface, miscut, args.ai_corners_grade, args.ai_edges_grade)
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
