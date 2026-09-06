#!/usr/bin/env python3
"""Validate a repair graph and every required nested graph as one program."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


EXPECTED_PARENT_PROGRAM_ID = "mintvault-repository-architecture-recovery-20260904"
EXPECTED_SUBGRAPHS = {
    "white-ace-release-integrity": {
        "path": "../white-ace-assurance-repository-20260904/repair-graph.json",
        "program_id": "mintvault-white-ace-repair-20260904",
    }
}
TRACKED_ISSUE_ID = re.compile(r"\b(?:ARCH|SFAP)-[A-Z0-9._-]*[A-Z0-9]\b")
TRACKED_ISSUE_ROW = re.compile(
    r"^\|\s*`?((?:ARCH|SFAP)-[A-Z0-9._-]*[A-Z0-9])`?\s*\|",
    re.MULTILINE,
)


def run_validator(validator: Path, graph: Path, ready: bool) -> dict[str, Any]:
    command = [sys.executable, str(validator), str(graph)]
    if ready:
        command.append("--ready")
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        payload = {
            "valid": False,
            "ready": False,
            "errors": [
                f"validator returned non-JSON output for {graph}: "
                f"{completed.stderr.strip() or completed.stdout.strip()}"
            ],
        }
    payload["exit_code"] = completed.returncode
    return payload


def load_graph(graph: Path) -> dict[str, Any]:
    value = json.loads(graph.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{graph}: top-level graph must be an object")
    return value


def find_repository_root(graph: Path) -> Path | None:
    for candidate in graph.parents:
        if (candidate / "engineering" / "ISSUE_REGISTER.md").is_file():
            return candidate
    return None


def validate_issue_coverage(graph: Path, parent: dict[str, Any], errors: list[str]) -> None:
    local_register = graph.with_name("issue-register.md")
    repository_root = find_repository_root(graph)
    canonical_register = (
        repository_root / "engineering" / "ISSUE_REGISTER.md"
        if repository_root is not None
        else None
    )
    if not local_register.is_file():
        errors.append(f"architecture issue register not found: {local_register}")
        return
    if canonical_register is None or not canonical_register.is_file():
        errors.append("canonical engineering/ISSUE_REGISTER.md not found above program graph")
        return

    nodes = parent.get("nodes")
    if not isinstance(nodes, list):
        return
    node_by_id = {
        node.get("id"): node
        for node in nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    graph_issue_ids = {node_id for node_id in node_by_id if TRACKED_ISSUE_ID.fullmatch(node_id)}
    local_issue_ids = set(TRACKED_ISSUE_ROW.findall(local_register.read_text(encoding="utf-8")))
    missing_from_graph = local_issue_ids - graph_issue_ids
    missing_from_local = graph_issue_ids - local_issue_ids
    if missing_from_graph:
        errors.append(
            f"task issue register IDs missing graph nodes: {sorted(missing_from_graph)}"
        )
    if missing_from_local:
        errors.append(
            f"graph issue IDs missing task issue register entries: {sorted(missing_from_local)}"
        )

    canonical_text = canonical_register.read_text(encoding="utf-8")
    section_marker = "## 2026-09-04 repository architecture recovery correction"
    section_start = canonical_text.find(section_marker)
    if section_start < 0:
        errors.append(f"canonical issue register is missing section: {section_marker}")
        return
    section_tail = canonical_text[section_start + len(section_marker):]
    next_section = section_tail.find("\n## ")
    canonical_section = section_tail if next_section < 0 else section_tail[:next_section]
    canonical_issue_ids = set(TRACKED_ISSUE_ROW.findall(canonical_section))
    accepted_critical_ids = {
        node_id
        for node_id, node in node_by_id.items()
        if node.get("kind") == "FINDING" and node.get("severity") in {"BLOCKER", "HIGH"}
    }
    missing_from_canonical = accepted_critical_ids - canonical_issue_ids
    unknown_canonical = canonical_issue_ids - graph_issue_ids
    if missing_from_canonical:
        errors.append(
            "accepted parent BLOCKER/HIGH IDs missing canonical issue register section: "
            f"{sorted(missing_from_canonical)}"
        )
    if unknown_canonical:
        errors.append(
            f"canonical architecture issue IDs missing graph nodes: {sorted(unknown_canonical)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "graph",
        nargs="?",
        type=Path,
        default=Path(__file__).with_name("repair-graph.json"),
    )
    parser.add_argument("--ready", action="store_true")
    parser.add_argument(
        "--validator",
        type=Path,
        default=Path.home()
        / ".codex"
        / "skills"
        / "graph-loop-repair"
        / "scripts"
        / "validate_repair_graph.py",
    )
    args = parser.parse_args()

    graph = args.graph.resolve()
    validator = args.validator.resolve()
    errors: list[str] = []
    results: list[dict[str, Any]] = []

    if not validator.is_file():
        errors.append(f"graph validator not found: {validator}")
    if not graph.is_file():
        errors.append(f"program graph not found: {graph}")
    if errors:
        print(json.dumps({"valid": False, "ready": False, "errors": errors}, indent=2))
        return 1

    try:
        parent = load_graph(graph)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"valid": False, "ready": False, "errors": [str(error)]}, indent=2))
        return 1

    if parent.get("program_id") != EXPECTED_PARENT_PROGRAM_ID:
        errors.append(
            "parent program_id must be "
            f"{EXPECTED_PARENT_PROGRAM_ID!r}, got {parent.get('program_id')!r}"
        )
    validate_issue_coverage(graph, parent, errors)

    parent_result = run_validator(validator, graph, args.ready)
    results.append({"id": parent.get("program_id"), "path": str(graph), **parent_result})
    if parent_result.get("exit_code") != 0:
        errors.append(f"parent graph did not pass{' readiness' if args.ready else ''}: {graph}")

    subgraphs = parent.get("subgraphs", [])
    if not isinstance(subgraphs, list):
        errors.append("top-level subgraphs must be a list")
        subgraphs = []
    if len(subgraphs) != len(EXPECTED_SUBGRAPHS):
        errors.append(
            "top-level subgraphs must contain exactly the pinned required programs: "
            f"{sorted(EXPECTED_SUBGRAPHS)}"
        )

    tasks_root = graph.parent.parent.resolve()
    parent_candidate = parent.get("candidate_sha")
    parent_baseline = parent.get("baseline_sha")
    seen_ids: set[str] = set()
    seen_paths: set[Path] = set()
    for index, entry in enumerate(subgraphs):
        if not isinstance(entry, dict):
            errors.append(f"subgraphs[{index}] must be an object")
            continue
        subgraph_id = entry.get("id")
        raw_path = entry.get("path")
        required = entry.get("required")
        if not isinstance(subgraph_id, str) or not subgraph_id.strip():
            errors.append(f"subgraphs[{index}].id must be a non-empty string")
            continue
        if not isinstance(raw_path, str) or not raw_path.strip():
            errors.append(f"subgraphs[{index}].path must be a non-empty string")
            continue
        if subgraph_id in seen_ids:
            errors.append(f"duplicate subgraph id: {subgraph_id}")
            continue
        seen_ids.add(subgraph_id)
        expected = EXPECTED_SUBGRAPHS.get(subgraph_id)
        if expected is None:
            errors.append(f"unrecognized required subgraph id: {subgraph_id}")
            continue
        if raw_path != expected["path"]:
            errors.append(
                f"subgraph {subgraph_id} path must be {expected['path']!r}, got {raw_path!r}"
            )
            continue
        if required is not True:
            errors.append(f"subgraph {subgraph_id} must declare required=true")
            continue
        subgraph = (graph.parent / raw_path).resolve()
        if subgraph == graph:
            errors.append(f"subgraph {subgraph_id} must not reference the parent graph")
            continue
        try:
            subgraph.relative_to(tasks_root)
        except ValueError:
            errors.append(f"subgraph {subgraph_id} escapes the controlled tasks root")
            continue
        if subgraph in seen_paths:
            errors.append(f"duplicate subgraph path: {subgraph}")
            continue
        seen_paths.add(subgraph)
        try:
            subgraph_data = load_graph(subgraph)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            errors.append(f"subgraph {subgraph_id}: {error}")
            continue
        if subgraph_data.get("program_id") != expected["program_id"]:
            errors.append(
                f"subgraph {subgraph_id} program_id must be {expected['program_id']!r}, "
                f"got {subgraph_data.get('program_id')!r}"
            )
        if subgraph_data.get("baseline_sha") != parent_baseline:
            errors.append(
                f"required subgraph {subgraph_id} baseline_sha does not equal parent baseline_sha"
            )
        if subgraph_data.get("candidate_sha") != parent_candidate:
            errors.append(
                f"required subgraph {subgraph_id} candidate_sha does not equal parent candidate_sha"
            )
        result = run_validator(validator, subgraph, args.ready)
        results.append({"id": subgraph_id, "path": str(subgraph), **result})
        if result.get("exit_code") != 0:
            errors.append(
                f"required subgraph {subgraph_id} did not pass"
                f"{' readiness' if args.ready else ''}: {subgraph}"
            )

    missing_ids = set(EXPECTED_SUBGRAPHS) - seen_ids
    if missing_ids:
        errors.append(f"missing pinned required subgraphs: {sorted(missing_ids)}")

    structurally_valid = not errors and all(result.get("valid") is True for result in results)
    ready = (
        args.ready
        and structurally_valid
        and isinstance(parent_candidate, str)
        and bool(parent_candidate)
        and all(result.get("ready") is True for result in results)
    )
    output = {
        "valid": structurally_valid,
        "ready": ready,
        "program_id": parent.get("program_id"),
        "candidate_sha": parent_candidate,
        "graph_count": len(results),
        "graphs": results,
        "errors": errors,
    }
    print(json.dumps(output, indent=2))
    return 0 if structurally_valid and (not args.ready or ready) else 1


if __name__ == "__main__":
    raise SystemExit(main())
