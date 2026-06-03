---
title: "Grading Standards"
document: "MintVault — Grading Standards"
version: "v1.1-draft"
status: "Draft — pending Adam J review (Stage B) of the 2026-06 surface deduction table"
lastUpdated: "[TO BE INSERTED AT GO-LIVE]"
effectiveFrom: "[TO BE INSERTED AT GO-LIVE]"
---

# Grading Standards

## Overview

MintVault grading is a professional opinion issued by trained graders using a consistent methodology. Grading is not a guarantee of authenticity beyond the authentication process; see our Submission Agreement.

## Subgrades

Every graded card receives four subgrades:

- **Centering** — alignment of the card face and back within the cardstock borders
- **Corners** — sharpness and integrity of all four corners
- **Edges** — cleanness of all four edges, free of whitening or chipping
- **Surface** — absence of print defects, scratches, scuffs, and surface wear

## Overall Grade

The overall grade reflects the cumulative subgrade assessment and is expressed on a 1–10 scale.

## Black Label

Black Label is awarded **automatically** when all four recorded subgrades are each 10.

- No separate opt-in required.
- No extra fee.
- Black Label is part of the grading outcome, not a paid upgrade.

Absence of Black Label is not itself proof of grading error.

## Surface defect classification

> **PENDING REVIEW (Adam J, Stage B — 2026-06).** This table is the published
> form of the per-defect deduction MintVault grading engine uses for Surface
> subgrade scoring. It must match the engine source at
> `shared/mvgs-scoring.ts` (single-source-of-truth rule). The 2026-06 ST
> rows below are the visible change.

Surface defects observed on the card are classified by **defect code** (what
the mark is) and **severity tier** (how serious the mark is). Each pin
deducts from a 25-point Surface budget. The grader's classification
determines the deduction.

| Code | Defect                                   | Tier D1 (front / back)        | Tier D2 (front / back) | Tier D3 (Factory — documented only) |
| ---- | ---------------------------------------- | ----------------------------- | ---------------------- | ----------------------------------- |
| SP   | Gloss-penetrating scratch                | −4 (front art/holo ×1.5) / −2 | —                      | 0                                   |
| CR   | Crease (also caps headline grade at 7.4) | −10                           | —                      | 0                                   |
| SC   | Surface scratch                          | −2 / −1                       | −0.5                   | 0                                   |
| SV   | Silvering                                | −3 / −1.5                     | —                      | 0                                   |
| ST   | Stain                                    | −2 / −1                       | **−0.5 (2026-06)**     | **0 (2026-06)**                     |
| GL   | Gloss flaw                               | −4 / −2                       | —                      | 0                                   |
| PL   | Print line                               | —                             | −0.5                   | 0                                   |
| PS   | Print spot                               | —                             | −0.25                  | 0                                   |
| PI   | Print imperfection                       | —                             | −0.5                   | 0                                   |
| WH   | Surface whitening                        | —                             | −0.5                   | 0                                   |

Back-surface deductions are multiplied by ×0.5 — back-side defects affect the
grade less than front-side defects, matching MintVault's published lenient
back treatment. D3 defects are documented on the certificate's Condition
Report but never deduct from the Surface subgrade — they describe minor
factory artefacts (printing variation, registration drift, etc.) that the
customer is entitled to see but which do not lower the grade.

## Corrections

Mechanical recording errors are handled through our Guarantee & Correction Policy.

## Versioning

Grading standards may be updated from time to time. The version of the standards in effect at the date of submission applies to your submission, unless expressly stated otherwise.
