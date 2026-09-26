# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

> This release changes what the extension optimizes for: **fewer tokens in total**, not the same amount moved from the
> supervisor to a worker. Measured on two real tasks, a delegation costs on the order of 100k tokens before it changes a
> line, so delegating a small, fully specified change lost tokens instead of saving them. Delegation is now a decision,
> not a default. README has the economics and the cases where it pays off.

### Added

- The supervisor keeps `edit` and `write` (`supervisorTools`), and its policy states when to use them: a change of about twenty lines or fewer, or one short new file, whose exact content it already knows and whose code it has already read, is made directly and verified with `run_verification` instead of starting a worker. Anything that needs exploration, spans several files or symbols, is long or is risky is still delegated, and one change is never split between the two.
- `npm audit --omit=dev` and `npm pack --dry-run` to the default `verificationCommands`: both are read-only, so the supervisor can run them with `run_verification` and put them in `VERIFY`, and workers are authorized for them like every other check. No mutating form is allowed (`npm audit fix`, or `npm pack` without `--dry-run`, which writes a tarball into the repository).

### Changed

- Workers no longer run the project's checks themselves: the extension runs the `VERIFY` commands on the finished work and hands back any failure, so a worker does not spend turns on them and does not carry their whole output into every one of its later turns. It is still authorized to run them.
- `workerMaxTurns` defaults drop to 16/32/64/96 per profile (were 40/80/120/160). A worker re-reads its context on every turn, so its cost is turns × context: in a measured refactor one worker used all 80 turns of the medium profile and 3.9M cache-read tokens. Reaching the cap still stops the delegation while keeping the session and the work, so the supervisor continues it.
- A `VERIFY` line that lists several commands separated by `;` or `&&` now contributes each of them, run one by one and never through a shell: `VERIFY: npm test; npm audit --omit=dev` used to be rejected whole, which silently left a delegation without any automatic verification. Each part is still parsed and allowlisted on its own, so an unknown or dangerous neighbour never runs. A line whose parts would change the working directory or the environment (`cd packages/app && npm test`) is still kept whole and rejected, because running only part of it would check the wrong place; any other shell syntax (a pipe, a redirection, `||`, a single `&`, a substitution) still rejects the line.
- A full stop ends a bare `VERIFY` command wherever it appears, not only at the end of the line, so the sentence after it stays prose (`VERIFY: npm pack --dry-run --json. Also validate the workflow.`). Dots that belong to a command (`npx tsc -p .`, `go test ./...`, `npx eslint src/.`) are kept.
- Claude workers now receive the `[WORKER NOTES]`, which only Pi workers without a shell used to get: every worker is now told which commands the extension will run on its work, not to run them itself, and never to claim a check it could not run.

### Fixed

- `complete_task` could not close a change the supervisor made itself: with no `plan_task` and no delegation there is no task packet, so it answered "No supervised task to complete". It now accepts such a change on the evidence of its own checks — at least one `run_verification` of this prompt passed and none failed — and says that nothing was recorded for worker learning, since no worker ran. A failing check of its own blocks acceptance exactly like a regression does.
- `VERIFY: Run npm test after the extraction` ran no check: the leading verb was read as the executable, so the delegation went unverified and the worker was left to check itself. An imperative introducing a bare command (`Run`, `Then execute`, `Please rerun`, …) is now dropped, one word at a time, only as long as what follows is an allowlisted command. A line that forbids a command (`Do not run npm test`) still yields nothing.

## [0.3.0] — 2026-09-25

### Added

- `review_changes`: independent review of a branch, pull request or local work against a base ref (default: the upstream, `origin/HEAD`, `main` or `master`), from the merge base, without the diff entering the supervisor's context. A diff larger than `maxDiffBytes` is split into parts (at most `reviewMaxShards`) reviewed in parallel, the families taking turns; a larger one is refused with its size per directory, so it can be reviewed in parts with `paths`. A later review of the same branch in the session checks the earlier findings and reviews only what changed since (`full: true` reviews it all again); from the third review of a branch the result asks the supervisor to report remaining findings to the user instead of starting another fix-and-review round.
- Audits (`consult_readonly`, `purpose: audit`) of more than `auditShardBytes` of source are split by directory among up to `auditMaxShards` consultants working in parallel; each holds only its part in context.
- Verification of MAJOR findings of `review_changes` and audits by a second model, of the other family where possible, given the cited code. Rejected findings are listed apart, with the reason, so the supervisor can overrule the verifier.
- Supervisor context pruning (`contextPruning`): at the end of a run, bulky tool results of accepted tasks become one-line notes, and reads of files a later delegation changed are marked outdated. Pi context edits change only what the model sees, and are applied only when they save at least `minTotalBytes`.
- Code map for fresh workers (`workerCodeMapBytes`): the outline, with line ranges, of authorized files of 500 lines or more (only the declarations the guide names when the outline is long), and where those declarations are used.

### Changed

- Reviews and audits report one line per finding (`- [MAJOR|MINOR] path:line — defect — fix`, every MAJOR and at most 10 MINOR, then `Risk:` lines), so parts can be merged, deduplicated and verified. MAJOR means wrong results, crashes, data loss or security holes in realistic use, missed requirements and regressions; hardening against inputs the callers never produce is MINOR. Audits that ask for an explanation instead answer it directly.
- The supervisor policy keeps fixes within the user's request: findings outside it (pre-existing code, extra hardening) are reported, not fixed unasked, and a third fix-and-review round on the same change needs the user's go-ahead.
- Every reviewer gets the code around each change (the declaration that contains it, or a window inside a long one) and the uses of the declarations the change touches, outside their own bodies (`reviewContextBytes`).
- The API reviewer gets whole changed files up to `reviewWholeFilesBytes`; above it, and up to 250 KB, small files whole and outlines of large ones, instead of every file in full.
- Reviewers, consultants and verifiers get the repository's instruction files (`AGENTS.md`, `CLAUDE.md`, up to 8 KB): they run without them and could not judge the code against the project's rules.
- The verifier can downgrade a real but immaterial MAJOR finding to MINOR, so severities are not inflated.
- `supervisor_git diff` does not send again a diff that the task's delegation results already showed whole, while those files are unchanged (more context remains available with `unifiedLines` above 5). Once the task is accepted, or its results pruned, diffs are sent again.
- A delegation result shows its diff up to 24 KB (was 12 KB): the supervisor reviews the diff anyway, and fetching it separately cost a turn.
- A guide whose `FILE:` lines each describe their change (`FILE: path: what changes`) is accepted without a separate `CHANGES:` section, instead of costing the supervisor a turn.
- Authorized paths the guide does not name no longer block the delegation: they are listed for the worker as authorized only if the change requires them.

### Fixed

- `VERIFY: npm test.` ran no check: the sentence's full stop was read as part of the command, so automatic verification and correction rounds were silently skipped. Dots that belong to a command (`npx tsc -p .`, `go test ./...`) are kept.
- Guides written as one paragraph (`FILE: a.ts. SYMBOLS: … CHANGES: … VERIFY: npm test.`) were rejected for missing sections: sections are now recognized after a sentence's end, and `CHANGE/CHANGES:` counts as `CHANGES:`.
- The invocation log no longer attributes consultations and reviews made after a task was completed to that task.

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
