#!/usr/bin/env python3
"""Hostile mutation tests for the pinned nested repair-program wrapper."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable


HERE = Path(__file__).resolve().parent
WRAPPER = HERE / "validate-program.py"
VALIDATOR = (
    Path.home()
    / ".codex"
    / "skills"
    / "graph-loop-repair"
    / "scripts"
    / "validate_repair_graph.py"
)
PARENT_NAME = "repository-architecture-recovery-20260904"
NESTED_NAME = "white-ace-assurance-repository-20260904"


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def make_fixture(root: Path) -> tuple[Path, Path]:
    tasks = root / ".claude" / "controlled-code-lead" / "tasks"
    parent_dir = tasks / PARENT_NAME
    nested_dir = tasks / NESTED_NAME
    engineering = root / "engineering"
    parent_dir.mkdir(parents=True)
    nested_dir.mkdir(parents=True)
    engineering.mkdir(parents=True)
    shutil.copy2(HERE / "repair-graph.json", parent_dir / "repair-graph.json")
    shutil.copy2(HERE / "issue-register.md", parent_dir / "issue-register.md")
    shutil.copy2(HERE.parent / NESTED_NAME / "repair-graph.json", nested_dir / "repair-graph.json")
    repository_root = next(
        candidate
        for candidate in HERE.parents
        if (candidate / "engineering" / "ISSUE_REGISTER.md").is_file()
    )
    shutil.copy2(repository_root / "engineering" / "ISSUE_REGISTER.md", engineering / "ISSUE_REGISTER.md")
    return parent_dir / "repair-graph.json", nested_dir / "repair-graph.json"


def run_wrapper(parent: Path) -> tuple[int, dict]:
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    completed = subprocess.run(
        [sys.executable, str(WRAPPER), str(parent), "--validator", str(VALIDATOR)],
        capture_output=True,
        text=True,
        check=False,
        env=environment,
    )
    return completed.returncode, json.loads(completed.stdout)


def mutate_parent(parent: Path, mutate: Callable[[dict], None]) -> None:
    value = json.loads(parent.read_text(encoding="utf-8"))
    mutate(value)
    write_json(parent, value)


def assert_rejected(name: str, mutate: Callable[[Path, Path], None], expected: str) -> None:
    with tempfile.TemporaryDirectory(prefix="mintvault-graph-hostile-") as temporary:
        parent, nested = make_fixture(Path(temporary))
        mutate(parent, nested)
        exit_code, result = run_wrapper(parent)
        combined_errors = "\n".join(result.get("errors", []))
        if exit_code == 0 or result.get("valid") is not False or expected not in combined_errors:
            raise AssertionError(
                f"{name}: expected rejection containing {expected!r}; "
                f"exit={exit_code}, result={result}"
            )


def main() -> int:
    if not VALIDATOR.is_file():
        raise FileNotFoundError(f"installed graph validator missing: {VALIDATOR}")

    with tempfile.TemporaryDirectory(prefix="mintvault-graph-control-") as temporary:
        parent, _ = make_fixture(Path(temporary))
        exit_code, result = run_wrapper(parent)
        if exit_code != 0 or result.get("valid") is not True or result.get("graph_count") != 2:
            raise AssertionError(f"control graph did not validate: {result}")

    assert_rejected(
        "deleted-subgraph",
        lambda parent, _nested: mutate_parent(parent, lambda value: value.update(subgraphs=[])),
        "exactly the pinned required programs",
    )
    assert_rejected(
        "parent-substitution",
        lambda parent, _nested: mutate_parent(
            parent,
            lambda value: value["subgraphs"][0].update(path="repair-graph.json"),
        ),
        "path must be",
    )
    assert_rejected(
        "unrelated-program-substitution",
        lambda _parent, nested: mutate_parent(
            nested,
            lambda value: value.update(program_id="unrelated-valid-repair-program"),
        ),
        "program_id must be",
    )
    assert_rejected(
        "baseline-mismatch",
        lambda _parent, nested: mutate_parent(
            nested,
            lambda value: value.update(baseline_sha="a" * 40),
        ),
        "baseline_sha does not equal",
    )
    assert_rejected(
        "candidate-mismatch",
        lambda parent, nested: (
            mutate_parent(parent, lambda value: value.update(candidate_sha="a" * 40)),
            mutate_parent(nested, lambda value: value.update(candidate_sha="b" * 40)),
        ),
        "candidate_sha does not equal",
    )
    assert_rejected(
        "duplicate-subgraph",
        lambda parent, _nested: mutate_parent(
            parent,
            lambda value: value["subgraphs"].append(dict(value["subgraphs"][0])),
        ),
        "duplicate subgraph id",
    )

    def prose_only_issue(parent: Path, _nested: Path) -> None:
        register = parent.with_name("issue-register.md")
        lines = register.read_text(encoding="utf-8").splitlines()
        lines = [line for line in lines if not re.match(r"^\|\s*`ARCH-POOL-001`\s*\|", line)]
        lines.append("\nARCH-POOL-001 is mentioned only in prose and is not a register row.")
        register.write_text("\n".join(lines) + "\n", encoding="utf-8")

    assert_rejected(
        "prose-only-issue-id",
        prose_only_issue,
        "graph issue IDs missing task issue register entries",
    )

    def self_reference(parent: Path, nested: Path) -> None:
        nested.unlink()
        nested.symlink_to(parent)

    assert_rejected("self-reference", self_reference, "must not reference the parent graph")

    def repository_escape(parent: Path, nested: Path) -> None:
        escaped = parent.parents[4] / "escaped-repair-graph.json"
        shutil.copy2(HERE.parent / NESTED_NAME / "repair-graph.json", escaped)
        nested.unlink()
        nested.symlink_to(escaped)

    assert_rejected("repository-escape", repository_escape, "escapes the controlled tasks root")
    print("PASS: pinned nested-program wrapper rejected 9 hostile graph/register mutations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
