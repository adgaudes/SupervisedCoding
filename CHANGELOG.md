# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-25

### Added

- `code_outline`: a deterministic outline of source files (functions, classes, methods, types, tests; Markdown headings) with line ranges, so the supervisor reads only the ranges it needs. TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, Swift, Ruby, PHP and Markdown; directories list the files Git does not ignore. With `references`, it lists where a symbol is used, each use with the function or class that contains it, to judge a change's impact (matched by name, like grep).
- Check reuse (`reuseChecks`, on by default): within one prompt, a delegation's starting checks reuse the results of the checks that closed the previous delegation, or of `run_verification`, when the repository state is exactly the same (HEAD, index and the content of every changed or untracked file). Results are dropped whenever a worker starts, and reuse is off when the supervisor has a shell.

### Changed

- A check already red when the task began is tolerated only while it fails the same way (failure signature); a new failure inside it is a regression. Passing tests added by the worker, renumbered TAP tests, durations and temp paths do not count as changes.
- Less context for the supervisor: `run_verification` returns a short tail when the command passes; pre-existing failures are shown once per task; the worker's report and reviews are shortened in the middle, so the review and the diff always fit the delegation result; per-tool caps in `outputLimits`.
- The supervisor policy asks for ranged reads and hands audits spanning many files to `consult_readonly` (`purpose: audit`), so the files are read in the consultant's context.
- VERIFY sections: labels such as `Commands:` no longer end the section, prose after a bare command is dropped, and an option is never left without its value.

### Fixed

- Verification commands that move the branch or HEAD, or change the index, stop the delegation before any worker or correction round and end the worker session. Files they write are reported, not counted as scope violations of the worker.
- `plan_task`, commit and push are rejected while a delegation is running.

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
