# Agent Instructions

This repository is in pre-PRD design discovery.

## Required workflow

1. For non-trivial product/design decisions, use a `grill-with-docs` style interview before implementation.
2. Keep stable domain vocabulary in `CONTEXT.md`.
3. Create ADRs only for decisions that are hard to reverse, surprising without context, and based on a real trade-off.
4. Do not expand MVP scope into cross-agent routing unless the product decision is explicitly revisited.
5. Prefer small, testable slices and preserve Windows-first constraints without hard-coding the domain model to Windows.

## Current MVP guardrails

- A task is bound to one Agent for its lifecycle.
- Capacity/eligibility scheduling is the core problem.
- Cross-agent task transfer is out of scope.
- Task isolation is required.
- No AI scoring/routing in the MVP.
- Default unattended permissions stop at local modification, tests, and local commit unless a later policy explicitly grants more.
