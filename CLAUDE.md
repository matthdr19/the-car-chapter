# The Car Chapter

## Product

The Car Chapter transforms a customer's car photos and story into a personalised automotive memory artwork.

Tagline:

"Some cars aren't just vehicles. They're chapters in your story."

Supporting idea:

"Not just what the car looked like. What it meant to you."

## Current phase

Launch Readiness + Founding Pilots.

Current priority:

Build and validate Intake Pilot v0.2 for the first 3 founding pilots.

## Existing website

The current website baseline is v1.4.

The existing visual direction is authoritative.

Do not redesign the website or brand unless explicitly requested.

Reference screenshots are available under:

`reference/screenshots/`

## Design direction

The Car Chapter should feel:

- premium
- editorial
- calm
- intimate
- automotive
- restrained

It should NOT look like:

- a SaaS dashboard
- a racing game
- a tuning website
- a generic AI-generated interface

## Current operating principle

Instrument before automate.

Do not build the Production Graph, CRM, customer dashboard, accounts, payment infrastructure or other platform systems unless explicitly requested.

## Founding Pilot H1

The first 3 pilots test product/process value, not willingness to pay.

Current rules:

- H1 pilots are free.
- No payment flow during H1.
- Target human production time: <= 90 minutes by Pilot #3, excluding passive generation waiting.
- No known major factual defect may be delivered.
- Source pixels govern visual truth.
- Preserve original source files without compression.
- Customer source photos must use private storage.

## Fidelity

Use the existing escalation vocabulary:

- L1 = minor / cosmetic localized defect
- L2 = major truth / identity defect
- L3 = major structural scene defect

A known L2 or L3 defect must never be delivered.

At the production ceiling:
1. remove / hide / occlude the unreliable element if the story remains valid;
2. otherwise mark the pilot as not delivered / fidelity failure.

## Intake Pilot v0.2

Current implementation priority:

Build a standalone, shareable, mobile-first intake for the first 3 founding pilots.

It must support:

- self vs gift
- narrative story intake
- vehicle temporal-state changes
- original photo uploads
- per-photo captions
- private source storage
- Formspark structured submission
- production consent
- separate optional portfolio consent

No payment.

The intake should be deployable independently from the main website.

## Project skills

Use the project skills under `.claude/skills/` when relevant:

- `tcc-form-engineering`
- `tcc-premium-ui`
- `tcc-accessibility`

These skills complement this file.

If a skill conflicts with an established The Car Chapter product or design decision, the established project decision wins.

## Scope discipline

Do not expand a task into a larger architecture project without explicit approval.

Prefer:
- solving the current observed problem;
- small maintainable changes;
- testing real pilot behaviour;
- preserving existing working code.

Do not automatically refactor unrelated code.

## Security

Never commit secrets.

Do not expose privileged credentials client-side.

Use environment variables for external-service credentials.

Private customer files must not use permanent public URLs.

## Git

`main` represents the stable baseline.

Perform implementation work on an appropriate working branch.

Before major changes:
- inspect the current branch;
- inspect `git status`;
- preserve unrelated work.

Do not force-push or rewrite history unless explicitly requested.

## Skill precedence and authority

Project-specific The Car Chapter guidance has priority over external skills.

When instructions conflict, use this order:

1. Security, privacy and source-data integrity requirements
2. This `CLAUDE.md` and TCC-specific skills
3. Established TCC product decisions and scope
4. Existing website v1.4 visual direction and reference screenshots
5. Accessibility and semantic correctness
6. Relevant external skills
7. Decorative preferences or implementation novelty

The TCC-specific skills are authoritative for their domains:

- `tcc-form-engineering` — forms, validation, uploads, submission states and intake UX
- `tcc-premium-ui` — TCC visual direction, hierarchy, motion and customer-facing UI
- `tcc-accessibility` — semantics, keyboard interaction, focus and accessible form behaviour

External skills provide implementation expertise. They must not override established The Car Chapter product decisions, visual direction, privacy requirements, architecture choices or scope constraints.

Use external skills selectively when relevant. Do not redesign, re-platform, add dependencies, introduce frameworks or expand scope merely because an external skill suggests doing so.

Emil, Taste and Impeccable are design-engineering references, not brand authority.

ECC security and verification skills are quality-control layers, not permission to introduce additional architecture or tooling.

When an external recommendation conflicts with the existing TCC v1.4 design, preserve TCC unless the user explicitly approves a change.
