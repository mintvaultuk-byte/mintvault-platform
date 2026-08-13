# Architecture after — Partner Pilot Pass 2 source packages A–C

```
Partner session + MFA + capability
        │
tenant/location partner_grading_enabled (restricted DB, fail closed)
        │
canonical server MVGS draft authority → pending_review / review_required
        │                                       │
scoped ready-station list ─→ target arm ─→ signed Mac captures TIFF ─→ Super Admin QA
        │                                │                                  │
        └──── source-only 0075: one active target per station ───────────────┘
```

- A Partner can select only a server-listed active/calibrated station in its
  permitted location; the route rechecks certificate assignment/provenance.
- The signed Mac remains the sole principal that claims/captures/uploads a
  target. The browser can observe only its own scoped session state.
- A Partner label preview is denied while `pending_review`; QA remains a
  Super Admin action.
- 0074 and 0075 are deliberately source-only. Their runtime behaviour is not
  claimed until the authorised migration protocol completes.
- Partner credit settlement and generic print-batch eligibility are still
  separate open work; this architecture must not be read as a release claim.
