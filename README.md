# SupervisedCoding

**Supervised multi-model coding for the [Pi](https://pi.dev) coding agent.** One model plans, delegates and accepts. Claude and GPT workers implement. Checks, independent reviews, credit failover and learning run on their own.

![Pi extension](https://img.shields.io/badge/Pi-extension-6f42c1) ![Node.js ≥ 22.16](https://img.shields.io/badge/node-%E2%89%A5%2022.16-339933) ![Models: Claude · GPT](https://img.shields.io/badge/models-Claude%20%C2%B7%20GPT-555) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**English** · [Italiano](#italiano)

SupervisedCoding turns Pi into a small engineering team. The model you talk to becomes a **supervisor**: it explores the code, classifies the task, writes a precise implementation guide and makes the final call. **Workers** — Claude through Claude Code, GPT through Pi — make the change. The extension runs your tests before and after, sends regressions back to the same worker, gets the change reviewed by a different model family, and keeps going when a subscription runs out.

Its priorities, in order:

1. correct, well-made code with as few defects as possible;
2. the right model and effort for each situation;
3. no interruptions when a model runs out of credits: the next one takes over;
4. as few tokens as possible, **never** at the expense of quality;
5. speed comes last.

## Features

- **Any model, any role.** Claude and GPT models can supervise, implement and review. Roles follow the task, never the model family. Claude workers run in Claude Code; GPT workers and any other model configured in Pi run through Pi's own CLI.
- **Structured delegation.** The supervisor classifies each task (profile, kind, risk, uncertainty, scope) and hands the worker a guide with `FILE`, `SYMBOLS`, `CHANGES`, `PRESERVE` and `VERIFY` sections.
- **Automatic verification against a task baseline.** Your test, typecheck and lint commands run before and after every change. A check that turned red during the task is a regression, even if an earlier step broke it. Only checks already red when the task began, and still failing the same way, are treated as pre-existing: a new failing test inside a red command is a regression, while passing tests added by the worker are not. A check that already ran on exactly the same code in the same prompt is not run again.
- **Self-correction in context.** The worker that caused a regression fixes it in its own session (up to 2 rounds by default), without weakening or deleting tests.
- **Independent review across families.** Large and critical work is reviewed by a model of another family first, and never by the implementer's own model unless nothing else is available. Before a large or critical task done in several steps is accepted, its whole diff is reviewed as one.
- **Explicit acceptance.** A task closes only through `complete_task`. It cannot be accepted with open regressions, a MAJOR finding or a missing review.
- **Credit-aware failover.** Exhausted providers are skipped until they reset, and near-limit ones move to the back. A worker that runs out mid-task hands its partial diff to the next one; a supervisor that runs out is replaced and the turn resumes on its own.
- **Learning from its own results.** Per repository and task kind, the extension raises effort when quality drops, escalates to a stronger model when that is not enough, lowers effort only after long clean streaks, and remembers repository-specific pitfalls as lessons.
- **Flagship models on request only.** Top-tier models (e.g. Claude Fable, GPT-6 Astra) run only on critical tasks and only after you say yes.
- **Budgets that keep your work.** Turn, time and cost limits stop a delegation between phases. The worker's session is kept, so the next step resumes it instead of starting over.
- **Guard rails.** Path allowlists, Git checks after every run, read-only reviewers, and no commit or push without your confirmation.
- **Transparent accounting.** Tokens and cost per model and role, with subscriptions kept apart from pay-per-use spend, plus a log of every invocation.

## How it works

### Roles

| Role | Who | Does |
|---|---|---|
| Supervisor | the active Pi model, picked by the extension | explores, classifies, writes the guide, reviews results, accepts |
| Worker | Claude via Claude Code, or any Pi model (e.g. GPT) via Pi's CLI | implements, inside the authorized paths only |
| Reviewer | any non-flagship model of the chains, read-only | reviews the diff and ends with `VERDICT: PASS \| MINOR \| MAJOR` |

### Life of a task

1. **Explore.** The supervisor reads only the files needed to judge the task, in parallel.
2. **Classify.** It picks a profile — `small`, `medium`, `large`, `critical` — and an assessment. The assessment can only **raise** the profile: security, concurrency, migrations or high risk mean critical; architecture, cross-system scope or high uncertainty mean at least large; several files mean at least medium. Large and critical work, or work that needs several steps, is recorded with `plan_task` first.
3. **Delegate.** `delegate_implementation` receives the guide and the authorized paths. The extension picks the worker, runs the `VERIFY` commands (baseline), lets the worker implement, runs the commands again, and hands regressions back to the same worker session.
4. **Review.** For large and critical profiles, an independent reviewer gets the diff of this step, plus the changed files when they fit.
5. **Accept.** The supervisor reads the result (the diff is included) and calls `complete_task`. For large or critical tasks done in several steps (or whose last step was not reviewed), this first runs a review of the whole task diff.
6. **Learn.** The outcome is recorded for calibration. Durable pitfalls become lessons (`record_lesson`), which every later worker in the repository receives.

### How the model and effort are chosen

The decision is split. **The supervisor** (a model) classifies the task; **the extension** chooses models and effort with deterministic rules:

1. **Supervisor for the first turn.** It must be chosen before the task is known: it is the first available model in `supervisorChain`. By default that is **GPT-5.5**, with Claude models and GPT-6 Sol as fallbacks. GPT-6 Astra takes over only for critical tasks, and only after you approve it.
2. **Eligible workers and starting order.** For each profile, `workerChains` lists eligible models of any family, in quality order, each with its effort. This order is a starting judgement, not a measurement: it holds until the repository provides evidence.
3. **Filters at every choice.** Exhausted accounts are skipped; accounts above 97 % of their quota move to the back; flagship models need your approval. The reviewer is never the implementer's model when anything else is available. Within one task, the supervisor and the implementer stay the same except after provider failures.
4. **Effort.** It starts from the configuration. Small, local, low-risk mechanical or documentation work drops to `low`. The supervisor may raise it for one delegation (and lower it only for small tasks). Learning raises it when quality drops, and lowers it only after long clean streaks.
5. **Escalation to a stronger model.** If the first model still performs poorly at its highest effort — or has no effort to raise — on at least 4 tasks of the same kind in the repository, the next candidate that is not struggling goes first. This applies to every profile.
6. **Savings.** For small and medium work only, a model moves ahead when it costs at least 20 % less with equal measured quality, after at least 20 accepted, test-verified, first-pass tasks of that kind for both models.

Every delegation result states why its order was used (`Routing: …`).

### Starting order

| Profile | When | Supervisor effort | Workers (starting order) | Independent review |
|---|---|---|---|---|
| small | local or mechanical change | medium | Sonnet 5 medium → GPT-6 Sol medium → Opus 5.5 low | no |
| medium | normal multi-file work | medium | Sonnet 5 high → GPT-5.5 high → Opus 5.5 medium → GPT-6 Sol high | no |
| large | architecture, hard debugging | high | Opus 5.5 high → GPT-5.5 xhigh → Sonnet 5 xhigh | yes |
| critical | security, concurrency, migrations, exceptional complexity | xhigh | **Fable 5.1 xhigh** → **GPT-6 Astra xhigh** (both need approval) → Opus 5.5 xhigh → GPT-5.5 xhigh → Sonnet 5 max | yes |

Why this order:

- **Claude first where the tool matters.** Claude Code can be restricted to the verification commands, so the worker runs the tests itself before it reports.
- **Families alternate.** GPT and Claude sit on different subscriptions: when one provider's limit is reached — the Claude window is shared by Sonnet and Opus — work continues on the other without stopping.
- **GPT-6 Sol on small tasks.** It costs less than GPT-5.5 ($2/$10 vs $5/$30 per million tokens in Pi's catalog). Its quality there is not yet measured: learning confirms or overrides the choice.

**Reviewers** come from the non-flagship models of the profile's chain and of the stronger profiles. Models of the other family go first, then other models of the implementer's family, and the implementer's own model only as a last resort. The API reviewer (`reviewApi`, GPT-5.5 by default) is tried first within its family, because it has no CLI overhead, but only when the diff and the changed files fit completely. A reviewer that returns no complete verdict — error, turn limit, truncated output, missing verdict — hands over to the next one.

### Credits and failover

| Provider | How credits are tracked |
|---|---|
| Claude Code | `rate_limit_event` on every call (5-hour and weekly windows, resets, models outside the plan), plus a small Haiku probe when the extension starts |
| Pi models (supervisor, GPT workers and reviewers) | limit headers and errors; a minimal probe of the supervisor that would be chosen (never a flagship) |

- Probes run only when the last reading is older than 15 minutes (`credits refresh` forces them). They are capped at a few tokens and show up in `status`.
- Blocks are as narrow as the limit: a model outside the plan blocks only that model; an Opus limit only Opus; an account limit the whole provider. Accounts on different providers are independent.
- **Workers.** A transient error gets up to 4 retries with growing waits, resuming the session the failed attempt opened. Credits, authentication or a missing model move on to the next candidate, with the partial diff. A coding error never switches model: the supervisor diagnoses it.
- **Supervisor.** On a credit error the extension switches the Pi model and resumes the turn with a `[SUPERVISOR FAILOVER]` note. If no supervisor is left, it offers to finish the open task with the workers, through the same pipeline; the result still needs the supervisor's acceptance.

### Learning

Outcomes live in the Pi agent directory (see [Data and privacy](#data-and-privacy)) and are shared by every session.

- **Effort calibration** per repository, task kind, profile and model. One task is one sample, scored by its **worst** delegation, so a failure repaired by a later step still counts as a failure. Provider failures, budget stops and outcomes older than 90 days are ignored.
- Quality below 0.7 over at least 4 tasks of **any kind** raises effort by one level.
- Effort drops one level only after **20 consecutive accepted tasks of the same kind** whose every delegation passed its tests at the first attempt. It never drops more than one level below the configuration, and never for large or critical work.
- After every change only newer outcomes count (no oscillation). A configuration change resets the baseline.
- **Lessons** (`record_lesson`) are concrete, repository-specific instructions — up to 15 per repository, 300 characters each — given to every fresh worker. Duplicates reinforce the existing lesson.

### Budgets

- **Turns per profile** for workers and reviewers: small 40, medium 80, large 120, critical 160. Claude Code enforces them with `--max-turns`; for Pi workers the extension counts turns and stops the run.
- **Time and cost per delegation** (`delegationTimeoutMinutes`, default 120; `delegationBudgetUsd`, off by default). They are checked **between phases**: a running worker is never killed, but no new attempt, correction or review starts afterwards. A skipped review is done by `complete_task`.
- When a limit stops a delegation, the partial work and the worker session are kept. The supervisor continues with `continuePrevious=true` instead of re-exploring. An extension limit is never treated as exhausted provider credits.

### Safety

- `allowedPaths` must be relative, without `..`, and cannot be `.` for normal delegations. They are enforced **after** each run: branch, HEAD, index and files outside the allowlist are checked. Files ignored by Git and writes outside the repository are not covered — it is a guard rail, not a sandbox.
- Claude workers run with `--safe-mode --restricted`, an allowlist of tools, the verification commands as the only shell commands, and every mutating Git command denied. Claude reviewers get `Read`, `Glob` and `Grep` only.
- Pi workers run with `--no-extensions --no-skills --no-context-files --no-approve` and, by default, **no shell** (`read`, `edit`, `write`, `grep`, `find`, `ls`), because Pi cannot restrict a shell to the verification commands; the extension runs them instead. Pi reviewers get `read`, `grep`, `find`, `ls`.
- `run_verification` accepts one plain allowlisted command, with `CI=1`, and reports any file it changed. A command that moves the branch or HEAD, or changes the index, fails the task and ends the worker session.
- Commits and pushes go only through `request_git_commit` / `request_git_push`, with your confirmation. No merge, no force-push.

## Installation

### Requirements

- [Pi](https://pi.dev) and Node.js ≥ 22.16.
- For Claude workers: [Claude Code](https://code.claude.com) installed and logged in (`claude` on your `PATH`).
- For GPT supervisors, workers and reviewers: Pi logged in to **OpenAI Codex** (ChatGPT subscription), or any other OpenAI provider configured in Pi.
- Optional: Pi logged in to **Anthropic**, so that Claude models can also act as supervisor when the GPT models run out of credits.

Pi's runtime packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) come with Pi itself: nothing else to install.

### Install

```bash
pi install git:github.com/adgaudes/SupervisedCoding
```

Pi clones the package and loads the extension on the next start (or after `/reload`). Pin a release tag with `@<tag>` for reproducible installs.

Alternatively, clone it into Pi's extension directory:

```bash
# macOS / Linux
git clone https://github.com/adgaudes/SupervisedCoding.git ~/.pi/agent/extensions/SupervisedCoding

# Windows (PowerShell)
git clone https://github.com/adgaudes/SupervisedCoding.git "$env:USERPROFILE\.pi\agent\extensions\SupervisedCoding"
```

### First run

In Pi:

```text
/SupervisedCoding on
```

The extension checks the providers' credits, selects the best available supervisor and replaces Pi's editing tools with its own. Then describe your task as usual.

### Personal settings

`config.json` in the package holds the defaults. To change them, create `<pi-agent-dir>/supervised-coding/config.json` (`~/.pi/agent/supervised-coding/config.json` unless `PI_CODING_AGENT_DIR` says otherwise) with only the keys you want to change. Objects are merged one level deep, so this replaces only the `medium` chain:

```json
{
  "workerChains": {
    "medium": [
      { "worker": "pi", "provider": "openai-codex", "model": "gpt-5.5", "effort": "high" },
      { "worker": "claude", "model": "claude-sonnet-5", "effort": "high" }
    ]
  }
}
```

Updates of the package never touch this file. Run `/reload` after editing it.

## Usage

```text
/SupervisedCoding on        enable, check credits, pick the supervisor
/SupervisedCoding off       disable and restore Pi's tools
/SupervisedCoding status    consumption per model and role, API spend vs subscriptions, quota movement, quality
/SupervisedCoding credits [refresh|reset]
/SupervisedCoding model [auto|manual]
/SupervisedCoding learning [forget <id>|reset]   what the extension learned in this repository
```

If you pick a model by hand, supervisor selection becomes `manual` (credit failover stays on); `/SupervisedCoding model auto` restores automatic selection.

### Supervisor tools

| Tool | Purpose |
|---|---|
| `plan_task` | records a large, critical or multi-step task with its profile and assessment; sets the supervisor's effort; proposes a flagship supervisor for critical work |
| `delegate_implementation` | runs the profile's worker chain with verification, self-correction, review and failover; `preferWorker` (`claude` / `gpt`) puts a family first |
| `complete_task` | `accept` closes the task (after the whole-task review when needed); `pause` keeps it open for later. Both release the flagship supervisor and reset the effort |
| `consult_readonly` | a focused read-only opinion from any model, or an audit of many files read in the consultant's context instead of the supervisor's (`purpose: audit`); `reviewer` (`claude` / `gpt`) picks the preferred family |
| `run_verification` | one allowlisted test, typecheck, lint or build command not already covered by `VERIFY` |
| `code_outline` | functions, classes, methods, types and tests of source files (headings for Markdown) with their line ranges, so the supervisor reads only the ranges it needs; with `references`, where a symbol is used and which function contains each use; deterministic, no model call |
| `record_lesson` | a durable repository pitfall for future workers |
| `supervisor_git` | read-only Git inspection |
| `request_git_commit`, `request_git_push` | only with your confirmation |

## Configuration

| Key | Meaning |
|---|---|
| `supervisorChain` | `{provider, model}` in order of preference; only models authenticated in Pi are used |
| `supervisorProfiles` | preferred supervisors per profile (empty by default: every switch rereads the conversation without prompt cache) |
| `supervisorEffort` | supervisor effort per profile (`default` = no open task) |
| `flagshipModels` | top-tier models: critical profile only, always after your approval |
| `workerChains` | per profile, eligible workers in starting quality order: `{worker: "claude", model, effort}` or `{worker: "pi", provider, model, effort}` |
| `independentReviewProfiles` | profiles with automatic review (default `large`, `critical`) |
| `reviewApi` | API reviewer through Pi (default `openai-codex/gpt-5.5`); `null` disables it |
| `learning.enabled`, `learning.autoTuneEffort`, `learning.autoRouteModels`, `learning.minModelSamples` | learning, effort calibration, evidence-based reordering |
| `autoVerify`, `maxCorrectionRounds`, `verificationCommands`, `verificationTimeoutMinutes` | automatic verification and allowlisted commands |
| `reuseChecks` | reuse a check's result within one prompt when it already ran on exactly the same repository state (HEAD, index, every changed or untracked file); off when the supervisor has `bash` |
| `workerMaxTurns`, `delegationTimeoutMinutes`, `delegationBudgetUsd` | budgets |
| `creditHeadroom`, `exhaustedCooldownMinutes`, `unavailableCooldownMinutes`, `probeTtlMinutes`, `probeMaxTokens` | credit handling |
| `transientRetryAttempts`, `transientRetryDelayMs`, `workerTimeoutMinutes`, `consultTimeoutMinutes` | retries and timeouts (0 = none) |
| `workerCommand`, `piCommand`, `piWorkerTools`, `piReadOnlyTools`, `worker*`, `claudeReadOnly*` | CLIs and tool permissions |
| `repoRulesFiles`, `minImplementationGuideChars`, `maxDiffBytes`, `maxOutputBytes`, `reviewMaxTokens`, `maxProcessOutputBytes` | prompts and output limits |
| `outputLimits` | per-tool caps on what reaches the supervisor's context: passing and failing `run_verification` output, consultations and reviews, the worker's report, `code_outline` |
| `supervisorAutoSelect`, `supervisorFailover`, `probeOnActivate`, `claudeProbeModel`, `automaticSupervisorRecovery`, `recoveryMaxAgeMinutes`, `allowedSupervisorProviders`, `supervisorTools`, `contextWarningPercent` | supervisor behavior |

## Data and privacy

Everything stays on your machine, in `<pi-agent-dir>/supervised-coding/`:

- `learning.json` — outcomes, calibrated efforts and lessons, per repository;
- `usage.jsonl` — one line per model invocation (task, role, provider, model, billing, tokens, cost); rotates to `usage.jsonl.1` beyond 5 MB;
- `pi-sessions/` — sessions of the Pi workers, so corrections can resume them;
- `config.json` — your personal settings, if you create one.

Data from versions before 0.1.0, stored inside the extension folder, is copied there on first start. `/SupervisedCoding learning reset` clears the learning data.

The extension calls real models on your subscriptions or API keys: every delegation, correction, review and probe consumes quota or money. `status` shows how much.

## Development

```bash
npm install
npm test        # unit, integration and regression tests, then typecheck
```

The tests never call a real model: they run the real extension against fake Claude Code and Pi CLIs, a fake Pi host and real Git repositories. `tests/resolve-pi.mjs` resolves Pi's packages from your local Pi installation.

| File | Contents |
|---|---|
| `index.ts` | Pi integration: tools, command, events, workers, verification, review, supervisor selection |
| `lib.ts` | failure classification, limit parsing, provider health, ranking |
| `learning.ts` | outcomes, effort calibration, lessons, verdicts, `VERIFY` extraction |
| `routing.ts` | task assessment, escalation, evidence-based ordering |
| `changes.ts` | checkpoints and per-delegation diffs |
| `config.json` | default configuration |
| `CHANGELOG.md` | release notes |

## License

[MIT](LICENSE) © adgaudes

---

## Italiano

**Coding supervisionato multi-modello per l'agente [Pi](https://pi.dev).** Un modello pianifica, delega e accetta. I worker Claude e GPT implementano. Verifiche, review indipendenti, failover sui crediti e apprendimento sono automatici.

[English](#supervisedcoding) · **Italiano**

SupervisedCoding trasforma Pi in un piccolo team di sviluppo. Il modello con cui parli diventa il **supervisore**: esplora il codice, classifica il task, scrive una guida di implementazione precisa e prende la decisione finale. I **worker** — Claude tramite Claude Code, GPT tramite Pi — fanno la modifica. L'estensione esegue i test prima e dopo, rimanda le regressioni allo stesso worker, fa rivedere la modifica da una famiglia di modelli diversa e va avanti quando un abbonamento esaurisce i crediti.

Le sue priorità, in ordine:

1. codice corretto, ben fatto e con meno errori possibili;
2. il modello e l'effort giusti per ogni situazione;
3. nessuna interruzione quando un modello esaurisce i crediti: subentra il successivo;
4. il minor consumo di token possibile, ma **mai** a scapito della qualità;
5. la velocità viene per ultima.

## Funzionalità

- **Qualsiasi modello, qualsiasi ruolo.** Claude e GPT possono supervisionare, implementare e rivedere. I ruoli seguono il task, mai la famiglia del modello. I worker Claude girano in Claude Code; i worker GPT, e qualsiasi altro modello configurato in Pi, girano tramite la CLI di Pi.
- **Deleghe strutturate.** Il supervisore classifica ogni task (profilo, tipo, rischio, incertezza, portata) e passa al worker una guida con le sezioni `FILE`, `SYMBOLS`, `CHANGES`, `PRESERVE` e `VERIFY`.
- **Verifica automatica rispetto alla baseline del task.** I comandi di test, typecheck e lint girano prima e dopo ogni modifica. Un controllo diventato rosso durante il task è una regressione, anche se l'ha causato un passo precedente. Sono considerati preesistenti solo i controlli già rossi all'inizio del task che falliscono ancora nello stesso modo: un nuovo test fallito dentro un comando già rosso è una regressione, mentre i test aggiunti dal worker che passano non lo sono. Un controllo già eseguito sullo stesso identico codice nello stesso prompt non viene rieseguito.
- **Auto-correzione nel contesto.** Il worker che ha causato una regressione la corregge nella propria sessione (fino a 2 giri di default), senza indebolire o cancellare test.
- **Review indipendente tra famiglie.** I lavori large e critical vengono rivisti prima da un modello di un'altra famiglia, e mai dal modello dell'implementatore se c'è un'alternativa. Prima di accettare un task large o critical svolto in più passi, il suo diff complessivo viene rivisto per intero.
- **Accettazione esplicita.** Un task si chiude solo con `complete_task`, che non accetta regressioni aperte, verdetti MAJOR o review mancanti.
- **Failover consapevole dei crediti.** I provider esauriti vengono saltati fino al reset, quelli vicini al limite vanno in fondo. Un worker che esaurisce i crediti a metà lavoro passa il diff parziale al successivo; un supervisore esaurito viene sostituito e il turno riprende da solo.
- **Apprendimento dai propri risultati.** Per repository e tipo di task l'estensione alza l'effort quando la qualità cala, passa a un modello più forte quando non basta, abbassa l'effort solo dopo lunghe serie pulite e ricorda le insidie del repository come lezioni.
- **Modelli di punta solo su richiesta.** I modelli di fascia alta (es. Claude Fable, GPT-6 Astra) si usano solo nei task critical e solo dopo il tuo sì.
- **Budget che non buttano il lavoro.** Limiti di turni, tempo e costo fermano una delega tra una fase e l'altra. La sessione del worker resta, quindi il passo successivo la riprende invece di ricominciare.
- **Protezioni.** Percorsi autorizzati, controlli Git dopo ogni esecuzione, revisori in sola lettura, nessun commit o push senza la tua conferma.
- **Consumi trasparenti.** Token e costi per modello e per ruolo, con gli abbonamenti separati dalla spesa a consumo, più un registro di ogni invocazione.

## Come funziona

### Ruoli

| Ruolo | Chi | Cosa fa |
|---|---|---|
| Supervisore | il modello attivo in Pi, scelto dall'estensione | esplora, classifica, scrive la guida, controlla i risultati, accetta |
| Worker | Claude tramite Claude Code, o qualsiasi modello di Pi (es. GPT) tramite la CLI di Pi | implementa, solo nei percorsi autorizzati |
| Revisore | qualsiasi modello non di punta delle catene, in sola lettura | rivede il diff e chiude con `VERDICT: PASS \| MINOR \| MAJOR` |

### Vita di un task

1. **Esplorazione.** Il supervisore legge solo i file necessari per valutare il task, in parallelo.
2. **Classificazione.** Sceglie un profilo — `small`, `medium`, `large`, `critical` — e un assessment. L'assessment può solo **alzare** il profilo: sicurezza, concorrenza, migrazioni o rischio alto portano a critical; architettura, portata cross-system o incertezza alta ad almeno large; più file ad almeno medium. I lavori large e critical, o in più passi, vengono prima registrati con `plan_task`.
3. **Delega.** `delegate_implementation` riceve la guida e i percorsi autorizzati. L'estensione sceglie il worker, esegue i comandi `VERIFY` (baseline), fa implementare, riesegue i comandi e rimanda le regressioni alla stessa sessione del worker.
4. **Review.** Nei profili large e critical un revisore indipendente riceve il diff di questo passo, più i file modificati quando entrano nel materiale.
5. **Accettazione.** Il supervisore legge il risultato (il diff è incluso) e chiama `complete_task`. Nei task large o critical svolti in più passi (o il cui ultimo passo non è stato rivisto) questo avvia prima una review del diff complessivo.
6. **Apprendimento.** L'esito viene registrato per la calibrazione. Le insidie durature diventano lezioni (`record_lesson`), che ogni worker successivo nel repository riceve.

### Come si scelgono modello ed effort

La decisione è divisa: **il supervisore** (un modello) classifica il task, **l'estensione** sceglie modelli ed effort con regole deterministiche.

1. **Supervisore del primo turno.** Va scelto prima di conoscere il task: è il primo modello disponibile di `supervisorChain`. Di default è **GPT-5.5**, con i modelli Claude e GPT-6 Sol come riserva. GPT-6 Astra subentra solo nei task critical e solo dopo la tua approvazione.
2. **Worker idonei e ordine iniziale.** Per ogni profilo `workerChains` elenca i modelli idonei, di qualsiasi famiglia, in ordine di qualità, ognuno con il suo effort. È un giudizio iniziale, non una misura: vale finché il repository non fornisce evidenze.
3. **Filtri a ogni scelta.** Gli account esauriti vengono saltati; quelli oltre il 97 % della quota vanno in fondo; i modelli di punta richiedono la tua approvazione. Il revisore non è mai il modello dell'implementatore se c'è un'alternativa. Dentro un task supervisore e implementatore restano gli stessi, salvo guasti del provider.
4. **Effort.** Parte dalla configurazione. Un lavoro small, locale, meccanico o di documentazione, a basso rischio, scende a `low`. Il supervisore può alzarlo per una delega (e abbassarlo solo nei task small). L'apprendimento lo alza quando la qualità cala e lo abbassa solo dopo lunghe serie pulite.
5. **Escalation a un modello più forte.** Se il primo modello va ancora male al suo effort più alto — o non ha un effort da alzare — su almeno 4 task dello stesso tipo nel repository, passa davanti il primo candidato che non è in difficoltà. Vale per tutti i profili.
6. **Risparmio.** Solo nei lavori small e medium, un modello passa davanti se costa almeno il 20 % in meno a parità di qualità misurata, dopo almeno 20 task dello stesso tipo accettati, verificati dai test e riusciti al primo colpo per entrambi i modelli.

Il risultato di ogni delega riporta il motivo dell'ordine usato (`Routing: …`).

### Ordine iniziale

| Profilo | Quando | Effort supervisore | Worker (ordine iniziale) | Review indipendente |
|---|---|---|---|---|
| small | modifica locale o meccanica | medium | Sonnet 5 medium → GPT-6 Sol medium → Opus 5.5 low | no |
| medium | lavoro normale, multi-file | medium | Sonnet 5 high → GPT-5.5 high → Opus 5.5 medium → GPT-6 Sol high | no |
| large | architettura, debugging difficile | high | Opus 5.5 high → GPT-5.5 xhigh → Sonnet 5 xhigh | sì |
| critical | sicurezza, concorrenza, migrazioni, complessità eccezionale | xhigh | **Fable 5.1 xhigh** → **GPT-6 Astra xhigh** (entrambi con approvazione) → Opus 5.5 xhigh → GPT-5.5 xhigh → Sonnet 5 max | sì |

Perché quest'ordine:

- **Claude davanti dove conta lo strumento.** Claude Code si può limitare ai soli comandi di verifica, quindi il worker esegue i test da solo prima di consegnare.
- **Le famiglie si alternano.** GPT e Claude stanno su abbonamenti diversi: quando un provider raggiunge il limite — la finestra Claude è condivisa da Sonnet e Opus — il lavoro continua sull'altro senza fermarsi.
- **GPT-6 Sol nei task small.** Costa meno di GPT-5.5 ($2/$10 contro $5/$30 per milione di token nel catalogo di Pi). La sua qualità qui non è ancora misurata: l'apprendimento conferma o scavalca la scelta.

**Revisori:** i modelli non di punta della catena del profilo e dei profili superiori. Prima quelli dell'altra famiglia, poi gli altri della famiglia dell'implementatore, e il modello dell'implementatore solo come ultima risorsa. Il revisore API (`reviewApi`, GPT-5.5 di default) viene provato per primo nella sua famiglia, perché non ha l'overhead di una CLI, ma solo quando diff e file modificati ci stanno per intero. Un revisore che non produce un verdetto completo — errore, limite di turni, output troncato, verdetto mancante — passa la mano al successivo.

### Crediti e failover

| Provider | Come si seguono i crediti |
|---|---|
| Claude Code | `rate_limit_event` a ogni chiamata (finestre di 5 ore e settimanali, reset, modelli fuori piano), più una piccola sonda Haiku all'avvio dell'estensione |
| Modelli di Pi (supervisore, worker e revisori GPT) | header di limite ed errori; una sonda minima del supervisore che verrebbe scelto (mai un modello di punta) |

- Le sonde partono solo se l'ultima lettura ha più di 15 minuti (`credits refresh` le forza). Sono limitate a pochi token e compaiono in `status`.
- I blocchi sono stretti quanto il limite: un modello fuori piano blocca solo quel modello, un limite Opus solo Opus, un limite dell'account tutto il provider. Account su provider diversi sono indipendenti.
- **Worker.** Un errore temporaneo ha fino a 4 retry con attese crescenti, riprendendo la sessione aperta dal tentativo fallito. Crediti, autenticazione o modello mancante passano al candidato successivo, con il diff parziale. Un errore di coding non cambia mai modello: lo diagnostica il supervisore.
- **Supervisore.** Su un errore di crediti l'estensione cambia modello in Pi e riprende il turno con una nota `[SUPERVISOR FAILOVER]`. Se non resta nessun supervisore, propone di completare il task aperto con i worker, con la stessa pipeline; il risultato va comunque accettato dal supervisore.

### Apprendimento

Gli esiti stanno nella cartella dell'agente Pi (vedi [Dati e privacy](#dati-e-privacy)) e sono condivisi da tutte le sessioni.

- **Calibrazione dell'effort** per repository, tipo di task, profilo e modello. Un task è un campione, valutato con la sua delega **peggiore**: un fallimento rimediato da un passo successivo resta un fallimento. Guasti dei provider, arresti per budget ed esiti più vecchi di 90 giorni vengono ignorati.
- Una qualità sotto 0,7 su almeno 4 task di **qualsiasi tipo** alza l'effort di un livello.
- L'effort scende di un livello solo dopo **20 task consecutivi dello stesso tipo, accettati**, con ogni delega riuscita al primo colpo e verificata dai test. Non scende mai più di un livello sotto la configurazione, e mai nei lavori large o critical.
- Dopo ogni cambio contano solo gli esiti successivi (nessuna oscillazione). Una modifica alla configurazione azzera la base.
- **Lezioni** (`record_lesson`): istruzioni concrete e specifiche del repository — fino a 15 per repository, 300 caratteri ciascuna — date a ogni nuovo worker. I duplicati rafforzano la lezione esistente.

### Budget

- **Turni per profilo** per worker e revisori: small 40, medium 80, large 120, critical 160. Claude Code li applica con `--max-turns`; per i worker Pi l'estensione conta i turni e ferma l'esecuzione.
- **Tempo e costo per delega** (`delegationTimeoutMinutes`, default 120; `delegationBudgetUsd`, disattivato di default). Vengono controllati **tra una fase e l'altra**: un worker in esecuzione non viene mai interrotto, ma dopo il limite non partono nuovi tentativi, correzioni o review. Una review saltata la fa `complete_task`.
- Quando un limite ferma una delega, il lavoro parziale e la sessione del worker restano. Il supervisore prosegue con `continuePrevious=true` invece di rifare l'esplorazione. Un limite dell'estensione non viene mai trattato come crediti esauriti del provider.

### Sicurezza

- `allowedPaths` devono essere relativi, senza `..`, e non possono essere `.` nelle deleghe normali. Vengono controllati **dopo** ogni esecuzione: branch, HEAD, index e file fuori allowlist. File ignorati da Git e scritture fuori dal repository non sono coperti: è una protezione, non una sandbox.
- I worker Claude girano con `--safe-mode --restricted`, un'allowlist di strumenti, i soli comandi di verifica come comandi di shell e ogni comando Git che modifica lo stato vietato. I revisori Claude hanno solo `Read`, `Glob` e `Grep`.
- I worker Pi girano con `--no-extensions --no-skills --no-context-files --no-approve` e, di default, **senza shell** (`read`, `edit`, `write`, `grep`, `find`, `ls`), perché Pi non può limitare una shell ai comandi di verifica: li esegue l'estensione. I revisori Pi hanno `read`, `grep`, `find`, `ls`.
- `run_verification` accetta un solo comando semplice e autorizzato, con `CI=1`, e segnala i file che il comando modifica. Un comando che sposta il branch o HEAD, o modifica l'index, fa fallire il task e chiude la sessione del worker.
- Commit e push passano solo da `request_git_commit` / `request_git_push`, con la tua conferma. Niente merge né force-push.

## Installazione

### Requisiti

- [Pi](https://pi.dev) e Node.js ≥ 22.16.
- Per i worker Claude: [Claude Code](https://code.claude.com) installato e autenticato (`claude` nel `PATH`).
- Per supervisori, worker e revisori GPT: Pi autenticato con **OpenAI Codex** (abbonamento ChatGPT), o un altro provider OpenAI configurato in Pi.
- Facoltativo: Pi autenticato con **Anthropic**, così anche i modelli Claude possono fare da supervisore quando i GPT esauriscono i crediti.

I pacchetti runtime di Pi (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) arrivano con Pi stesso: non serve installare altro.

### Installare

```bash
pi install git:github.com/adgaudes/SupervisedCoding
```

Pi clona il pacchetto e carica l'estensione all'avvio successivo (o dopo `/reload`). Per installazioni riproducibili fissa un tag di release con `@<tag>`.

In alternativa, clonalo nella cartella delle estensioni di Pi:

```bash
# macOS / Linux
git clone https://github.com/adgaudes/SupervisedCoding.git ~/.pi/agent/extensions/SupervisedCoding

# Windows (PowerShell)
git clone https://github.com/adgaudes/SupervisedCoding.git "$env:USERPROFILE\.pi\agent\extensions\SupervisedCoding"
```

### Primo avvio

In Pi:

```text
/SupervisedCoding on
```

L'estensione controlla i crediti dei provider, sceglie il miglior supervisore disponibile e sostituisce gli strumenti di modifica di Pi con i propri. Poi descrivi il task come al solito.

### Impostazioni personali

Il `config.json` del pacchetto contiene i valori di default. Per cambiarli crea `<cartella-agente-pi>/supervised-coding/config.json` (`~/.pi/agent/supervised-coding/config.json`, salvo diversa indicazione di `PI_CODING_AGENT_DIR`) con le sole chiavi da cambiare. Gli oggetti vengono fusi a un livello di profondità, quindi questo sostituisce solo la catena `medium`:

```json
{
  "workerChains": {
    "medium": [
      { "worker": "pi", "provider": "openai-codex", "model": "gpt-5.5", "effort": "high" },
      { "worker": "claude", "model": "claude-sonnet-5", "effort": "high" }
    ]
  }
}
```

Gli aggiornamenti del pacchetto non toccano mai questo file. Dopo averlo modificato esegui `/reload`.

## Uso

```text
/SupervisedCoding on        attiva, controlla i crediti, sceglie il supervisore
/SupervisedCoding off       disattiva e ripristina gli strumenti di Pi
/SupervisedCoding status    consumi per modello e ruolo, spesa API separata dagli abbonamenti, variazione delle quote, qualità
/SupervisedCoding credits [refresh|reset]
/SupervisedCoding model [auto|manual]
/SupervisedCoding learning [forget <id>|reset]   cosa ha imparato l'estensione in questo repository
```

Se scegli un modello a mano, la selezione del supervisore diventa `manual` (il failover per crediti resta attivo); `/SupervisedCoding model auto` ripristina la scelta automatica.

### Strumenti del supervisore

| Strumento | Scopo |
|---|---|
| `plan_task` | registra un task large, critical o in più passi con profilo e assessment; imposta l'effort del supervisore; propone un supervisore di punta nei lavori critical |
| `delegate_implementation` | esegue la catena di worker del profilo con verifica, auto-correzione, review e failover; `preferWorker` (`claude` / `gpt`) mette una famiglia in testa |
| `complete_task` | `accept` chiude il task (dopo la review complessiva quando serve); `pause` lo lascia aperto per dopo. Entrambi rilasciano il supervisore di punta e azzerano l'effort |
| `consult_readonly` | un parere mirato in sola lettura da qualsiasi modello, oppure un audit di molti file letti nel contesto del consulente anziché in quello del supervisore (`purpose: audit`); `reviewer` (`claude` / `gpt`) sceglie la famiglia preferita |
| `run_verification` | un comando autorizzato di test, typecheck, lint o build non già coperto da `VERIFY` |
| `code_outline` | funzioni, classi, metodi, tipi e test dei file sorgente (titoli per il Markdown) con i loro intervalli di righe, così il supervisore legge solo gli intervalli che servono; con `references`, dove è usato un simbolo e quale funzione contiene ogni uso; deterministico, senza chiamate a modelli |
| `record_lesson` | un'insidia duratura del repository per i worker futuri |
| `supervisor_git` | ispezione Git in sola lettura |
| `request_git_commit`, `request_git_push` | solo con la tua conferma |

## Configurazione

| Chiave | Significato |
|---|---|
| `supervisorChain` | `{provider, model}` in ordine di preferenza; si usano solo i modelli autenticati in Pi |
| `supervisorProfiles` | supervisori preferiti per profilo (vuoto di default: ogni cambio rilegge la conversazione senza cache del prompt) |
| `supervisorEffort` | effort del supervisore per profilo (`default` = nessun task aperto) |
| `flagshipModels` | modelli di punta: solo profilo critical, sempre dopo la tua approvazione |
| `workerChains` | per profilo, i worker idonei in ordine iniziale di qualità: `{worker: "claude", model, effort}` o `{worker: "pi", provider, model, effort}` |
| `independentReviewProfiles` | profili con review automatica (default `large`, `critical`) |
| `reviewApi` | revisore API tramite Pi (default `openai-codex/gpt-5.5`); `null` lo disattiva |
| `learning.enabled`, `learning.autoTuneEffort`, `learning.autoRouteModels`, `learning.minModelSamples` | apprendimento, calibrazione dell'effort, riordino basato su evidenze |
| `autoVerify`, `maxCorrectionRounds`, `verificationCommands`, `verificationTimeoutMinutes` | verifica automatica e comandi autorizzati |
| `reuseChecks` | riusa il risultato di un controllo, nello stesso prompt, se è già stato eseguito sullo stesso identico stato del repository (HEAD, index, ogni file modificato o non tracciato); disattivato se il supervisore ha `bash` |
| `workerMaxTurns`, `delegationTimeoutMinutes`, `delegationBudgetUsd` | budget |
| `creditHeadroom`, `exhaustedCooldownMinutes`, `unavailableCooldownMinutes`, `probeTtlMinutes`, `probeMaxTokens` | gestione dei crediti |
| `transientRetryAttempts`, `transientRetryDelayMs`, `workerTimeoutMinutes`, `consultTimeoutMinutes` | retry e timeout (0 = nessuno) |
| `workerCommand`, `piCommand`, `piWorkerTools`, `piReadOnlyTools`, `worker*`, `claudeReadOnly*` | CLI e permessi degli strumenti |
| `repoRulesFiles`, `minImplementationGuideChars`, `maxDiffBytes`, `maxOutputBytes`, `reviewMaxTokens`, `maxProcessOutputBytes` | prompt e limiti di output |
| `outputLimits` | limiti per tool su ciò che entra nel contesto del supervisore: output di `run_verification` riuscito o fallito, consulenze e review, report del worker, `code_outline` |
| `supervisorAutoSelect`, `supervisorFailover`, `probeOnActivate`, `claudeProbeModel`, `automaticSupervisorRecovery`, `recoveryMaxAgeMinutes`, `allowedSupervisorProviders`, `supervisorTools`, `contextWarningPercent` | comportamento del supervisore |

## Dati e privacy

Tutto resta sul tuo computer, in `<cartella-agente-pi>/supervised-coding/`:

- `learning.json` — esiti, effort calibrati e lezioni, per repository;
- `usage.jsonl` — una riga per ogni invocazione di un modello (task, ruolo, provider, modello, billing, token, costo); oltre 5 MB ruota in `usage.jsonl.1`;
- `pi-sessions/` — le sessioni dei worker Pi, così le correzioni possono riprenderle;
- `config.json` — le tue impostazioni personali, se lo crei.

I dati delle versioni precedenti alla 0.1.0, salvati nella cartella dell'estensione, vengono copiati lì al primo avvio. `/SupervisedCoding learning reset` cancella i dati di apprendimento.

L'estensione chiama modelli reali sui tuoi abbonamenti o sulle tue chiavi API: ogni delega, correzione, review e sonda consuma quota o denaro. `status` mostra quanto.

## Sviluppo

```bash
npm install
npm test        # test unitari, d'integrazione e di regressione, poi typecheck
```

I test non chiamano mai un modello reale: eseguono la vera estensione contro CLI simulate di Claude Code e Pi, un host Pi simulato e repository Git reali. `tests/resolve-pi.mjs` risolve i pacchetti di Pi dalla tua installazione locale.

| File | Contenuto |
|---|---|
| `index.ts` | integrazione con Pi: strumenti, comando, eventi, worker, verifica, review, scelta del supervisore |
| `lib.ts` | classificazione degli errori, lettura dei limiti, stato dei provider, ordinamento |
| `learning.ts` | esiti, calibrazione dell'effort, lezioni, verdetti, estrazione di `VERIFY` |
| `routing.ts` | assessment del task, escalation, ordinamento basato su evidenze |
| `changes.ts` | checkpoint e diff per singola delega |
| `config.json` | configurazione di default |
| `CHANGELOG.md` | note di rilascio |

## Licenza

[MIT](LICENSE) © adgaudes
