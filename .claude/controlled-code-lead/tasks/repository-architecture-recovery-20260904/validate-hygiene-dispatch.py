#!/usr/bin/env python3
"""Read-only dispatch coverage check; not proof of repair or release readiness."""

import argparse
import copy
import hashlib
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
EXPECTED = {
    "HY-GIT": 1, "HY-DOCS": 1, "HY-CI": 1,
    "HY-DB": 2, "HY-SECURITY": 2, "HY-CONTRACTS": 2,
    "HY-RUNTIME": 3, "HY-STRUCTURE": 3, "HY-SCANNER": 3,
}
PROHIBITED = {
    "edit", "commit", "push", "merge", "deploy", "shared-migration",
    "secret-values", "provider-mutation", "delete", "spawn-children",
}
REQUIRED_NODES = {
    "HY-GIT": {"REM-GH-001", "EXTERNAL-GITHUB"},
    "HY-DOCS": {"ARCH-AUTHORITY-001", "REPAIR-AUTHORITY-CONTROLS"},
    "HY-CI": {"ARCH-CI-001", "REPAIR-CI-TOPOLOGY", "REM-SUPPLY-001", "WAA-GATE-001"},
    "HY-DB": {"ARCH-SCHEMA-001", "REPAIR-SCHEMA-AUTHORITY", "ARCH-POOL-001", "ARCH-PRINT-READINESS-001"},
    "HY-SECURITY": {"REL-TOKEN-001", "WAA-LOCAL-SECRET-001", "REM-SUPPLY-001", "ARCH-SESSION-001"},
    "HY-CONTRACTS": {"ARCH-SUPPLY-001", "ARCH-PRICING-001", "ARCH-ROLE-001", "ARCH-SESSION-001", "ARCH-LEGACY-AI-001", "REPAIR-ADMIN-PRINT"},
    "HY-RUNTIME": {"WAA-IMAGE-001", "WAA-IMAGE-002", "WAA-IMAGE-003", "WAA-CREDIT-001", "ARCH-SOCIAL-001", "ARCH-VQ-EXPORT-001", "ARCH-CYCLE-001", "ARCH-PROXY-001"},
    "HY-STRUCTURE": {"ARCH-CLIENT-001", "ARCH-ADMIN-TAB-001", "ARCH-DEAD-001", "ARCH-COMP-001", "REPAIR-SERVER-BOUNDARIES"},
    "HY-SCANNER": {"SFAP-002", "SFAP-007", "SFAP-009", "ARCH-LEGACY-OPS-001"},
}


def read_report(ref):
    """Restrict reads to retained governance artifacts, never arbitrary secret paths."""
    if not isinstance(ref, str) or Path(ref).is_absolute() or ".." in Path(ref).parts:
        raise ValueError("report must be a repository-relative governance artifact")
    target = (REPO / ref).resolve()
    allowed = [HERE, REPO / "engineering"]
    if (target.suffix not in {".md", ".json"}
            or not any(target.is_relative_to(root) for root in allowed)
            or target.name == "hygiene-dispatch.json"):
        raise ValueError("report path outside retained report scope")
    return target.read_bytes()


def validate(plan, node_ids, head, dispatched=False, report_loader=read_report):
    errors = []
    if plan.get("schema_version") != 1:
        errors.append("unsupported schema")
    if plan.get("parent_program") != "mintvault-repository-architecture-recovery-20260904":
        errors.append("wrong parent program")
    if not re.fullmatch(r"[0-9a-f]{40}", str(plan.get("planning_baseline_sha", ""))):
        errors.append("planning baseline must be an exact SHA")
    if (plan.get("max_parallel_agents") != 3 or plan.get("shared_writer") != "codex-lead"
            or plan.get("permission") != "read-only-investigation"
            or set(plan.get("prohibited", [])) != PROHIBITED):
        errors.append("dispatch safety contract changed")
    lanes = plan.get("lanes", [])
    if not isinstance(lanes, list) or not all(isinstance(lane, dict) for lane in lanes):
        return errors + ["lanes must be objects"]
    ids = [lane.get("id") for lane in lanes]
    if len(ids) != len(EXPECTED) or set(ids) != set(EXPECTED):
        errors.append("missing, extra or duplicate lane")
    if dispatched and plan.get("execution_sha") != head:
        errors.append("dispatch execution_sha is absent or stale versus HEAD")
    wave_agents = {}
    for lane in lanes:
        name = lane.get("id", "UNKNOWN")
        if lane.get("wave") != EXPECTED.get(name):
            errors.append(f"{name}: wrong wave")
        if lane.get("agent_mode") != "READ_ONLY" or lane.get("write_scope") != []:
            errors.append(f"{name}: investigator must be read-only")
        refs = lane.get("graph_nodes", [])
        if not refs or not set(refs) <= node_ids:
            errors.append(f"{name}: missing/unknown graph node reference")
        if not REQUIRED_NODES.get(name, set()) <= set(refs):
            errors.append(f"{name}: assigned issue coverage was removed")
        if not lane.get("scope") or not lane.get("deliverable"):
            errors.append(f"{name}: missing brief")
        if dispatched:
            agent, report = lane.get("assigned_agent"), lane.get("report")
            if not isinstance(agent, str) or not agent.strip() or agent == "codex-lead":
                errors.append(f"{name}: actual independent agent ID required")
            elif agent in wave_agents.setdefault(lane.get("wave"), set()):
                errors.append(f"{name}: same agent assigned twice within wave")
            else:
                wave_agents[lane.get("wave")].add(agent)
            if not isinstance(report, dict):
                errors.append(f"{name}: actual investigation report required")
            elif (report.get("sha") != head or report.get("observer") != agent
                  or report.get("result") not in {"PASS", "FAIL", "UNKNOWN"}
                  or not isinstance(report.get("ref"), str) or not report["ref"].strip()):
                errors.append(f"{name}: invalid report SHA/observer/result/reference")
            else:
                try:
                    content = report_loader(report["ref"])
                    if hashlib.sha256(content).hexdigest() != report.get("content_sha256"):
                        errors.append(f"{name}: report content hash is absent or stale")
                    body = content.decode("utf-8")
                    if not all(value in body for value in [head, name, agent]):
                        errors.append(f"{name}: retained report lacks SHA/lane/observer binding")
                except (OSError, ValueError, UnicodeError):
                    errors.append(f"{name}: report artifact missing, unreadable or outside scope")
    return errors


def self_test(plan, nodes, head):
    cases = []
    for mutate in (
        lambda p: p["lanes"].pop(),
        lambda p: p["lanes"].append(copy.deepcopy(p["lanes"][0])),
        lambda p: p["lanes"][0].update(write_scope=["server/"]),
        lambda p: p["lanes"][0].update(graph_nodes=["invented-node"]),
        lambda p: p["lanes"][0].update(graph_nodes=["REM-GH-001"]),
        lambda p: p.update(max_parallel_agents=9),
        lambda p: p.update(prohibited=[]),
    ):
        changed = copy.deepcopy(plan)
        mutate(changed)
        cases.append(bool(validate(changed, nodes, head)))
    populated = copy.deepcopy(plan)
    populated["execution_sha"] = head
    reports = {}
    for lane in populated["lanes"]:
        agent = "test-only-" + lane["id"]
        ref = "self-test-only-" + lane["id"]
        content = (head + " " + lane["id"] + " " + agent).encode()
        reports[ref] = content
        lane.update(assigned_agent=agent, report={
            "sha": head, "observer": agent, "result": "UNKNOWN", "ref": ref,
            "content_sha256": hashlib.sha256(content).hexdigest(),
        })
    def fake_loader(ref):
        if ref not in reports:
            raise FileNotFoundError(ref)
        return reports[ref]
    cases.append(not validate(populated, nodes, head, True, fake_loader))
    populated["execution_sha"] = "0" * 40
    cases.append(bool(validate(populated, nodes, head, True, fake_loader)))
    populated["execution_sha"] = head
    for mutate in (
        lambda p: p["lanes"][0].update(report=None),
        lambda p: p["lanes"][0]["report"].update(ref="missing-report"),
        lambda p: p["lanes"][0]["report"].update(content_sha256="0" * 64),
        lambda p: p["lanes"][0]["report"].update(observer="wrong-observer"),
    ):
        changed = copy.deepcopy(populated)
        mutate(changed)
        cases.append(bool(validate(changed, nodes, head, True, fake_loader)))
    return all(cases), len(cases)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dispatched", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        plan = json.loads((HERE / "hygiene-dispatch.json").read_text())
        paths = [HERE / "repair-graph.json",
                 HERE.parent / "white-ace-assurance-repository-20260904/repair-graph.json"]
        nodes = {n["id"] for path in paths for n in json.loads(path.read_text())["nodes"]}
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        errors = validate(plan, nodes, head, args.dispatched)
        tests, count = self_test(plan, nodes, head) if args.self_test else (True, 0)
        if not tests:
            errors.append("dispatch negative self-tests failed")
        print(json.dumps({"valid": not errors, "mode": "dispatched" if args.dispatched else "plan",
                          "head": head, "self_tests": count, "errors": errors}, indent=2))
        return 1 if errors else 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as exc:
        print(json.dumps({"valid": False, "errors": [str(exc)]}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
