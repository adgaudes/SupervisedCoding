# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-09-24

First public release.

### Added

- Supervisor/worker/reviewer pipeline for Pi, with Claude (Claude Code) and GPT (Pi's own CLI) as interchangeable models in every role.
- Structured implementation guides, task assessment with risk-based profile floors, and explicit task acceptance through `complete_task`.
- Automatic verification before and after every change against a per-task baseline, with bounded self-correction in the worker's own session. Commands that resolve to the same package script run once.
- Independent review ordered by model family, with the implementer's own model as a last resort, and a review of the whole task before accepting large or critical work done in several steps.
- Credit-aware failover for workers, reviewers and the supervisor, with credit probes limited in time and accounted for.
- Learning per repository and task kind: effort calibration scored by each task's worst delegation, escalation to a stronger model, evidence-based savings, and repository lessons.
- Turn, time and cost budgets that stop a delegation between phases and keep the worker session for a follow-up.
- Flagship models restricted to critical work and to explicit user approval.
- Personal settings and user data in `<pi-agent-dir>/supervised-coding/`, outside the package; data of earlier versions is migrated on first start.
- Installation as a Pi package (`pi install git:github.com/adgaudes/SupervisedCoding`).
