# GitHub Actions no-run diagnosis
Captured: 2026-08-06T18:39:40Z

Symptom: push of f4fbb7e2 created NO workflow run; PR #288 reports no checks.

Ruled OUT, each with evidence:
  1. push did not reach GitHub    -> git/ref/heads/... returns f4fbb7e2 (matches local HEAD)
  2. PR head mismatch             -> gh pr view headRefOid = f4fbb7e2
  3. branch/path filters          -> on.pull_request.branches=[main]; PR base IS main
  4. concurrency cancellation     -> no concurrency block anywhere in ci.yml
  5. draft PR guard               -> no 'draft' reference in ci.yml; and earlier runs on THIS
                                     same draft PR did fire (c0171d3c, a869a00f, 421cdbd5)
  6. Actions disabled/suspended   -> actions/permissions {enabled:true, allowed_actions:all}
     quota                        -> repo is PUBLIC (private:false) => unmetered Actions
     repo state                   -> archived:false, disabled:false

ROOT CAUSE (confirmed): githubstatus.com components API reports
    Actions          major_outage
    Git Operations   operational
    Webhooks         operational
    API Requests     operational
    Pull Requests    operational

This also explains the prior run 31121284264: all FOUR jobs ended 'cancelled'
(not 'failure') at ~15m with no superseding push - the outage killed them mid-run.

Actions NOT taken and why:
  - workflow_dispatch: ci.yml declares no workflow_dispatch trigger, so none is possible
    without editing the workflow; adding one during an Actions outage would not dispatch.
  - rerun of 31121284264: would re-run at c0171d3c, NOT the current head, so it could not
    constitute assurance for f4fbb7e2.
  - empty verification commit: a new push event cannot dispatch while Actions is down.

CONCLUSION: CI assurance for the current head is BLOCKED EXTERNALLY. No CI result is claimed.
Re-check when githubstatus reports Actions operational; the next push will dispatch normally.
