# SupervisedCoding (Pi extension)

Estensione Pi per il coding supervisionato. Obiettivi, in ordine di priorità:

1. codice corretto, ben fatto e con meno errori possibili;
2. per ogni situazione, il modello e l’effort migliori;
3. nessuna interruzione quando un modello esaurisce i crediti: si passa al successivo;
4. il minor consumo di token possibile, ma **mai** a scapito della qualità;
5. la velocità è sempre secondaria.

Il **supervisore** (il modello attivo in Pi) esplora, pianifica, delega, verifica e accetta. I **worker** (Claude Code CLI, Gemini CLI) implementano. L’estensione sceglie i modelli, controlla i crediti e gestisce i failover.

## Uso

```text
/SupervisedCoding on       attiva, controlla i crediti, sceglie il supervisore
/SupervisedCoding off      disattiva
/SupervisedCoding status   consumi per modello e per ruolo, spesa reale (API a consumo) separata dagli abbonamenti, crediti usati nella conversazione, qualità
/SupervisedCoding credits [refresh|reset]
/SupervisedCoding model [auto|manual]
/SupervisedCoding learning [forget <id>|reset]   cosa ha imparato l’estensione in questo repository
```

Dopo `on` basta descrivere il task. Per ogni nuovo task il supervisore:

1. legge solo i file e i simboli necessari per valutarlo;
2. chiama `plan_task` con il profilo di complessità;
3. delega con `delegate_implementation` e una guida strutturata, con i comandi di verifica nella sezione `VERIFY`;
4. l’estensione esegue quei comandi prima e dopo la modifica e fa correggere al worker le eventuali regressioni (vedi sotto);
5. rivede il risultato (diff-stat, diff mirati, review indipendente) e usa `run_verification` per ciò che `VERIFY` non copre;
6. per correzioni o passi successivi dello stesso task riprende la sessione del worker (`continuePrevious`);
7. quando scopre un’insidia ricorrente del repository la registra con `record_lesson`.

## Ciclo di qualità

Per ogni delega:

1. **Contesto del repository.** Il worker riceve `AGENTS.md`/`CLAUDE.md` (in `--safe-mode` non li caricherebbe da solo) e le lezioni imparate in quel repository.
2. **Baseline.** I comandi di `VERIFY` presenti in `verificationCommands` (es. `npm test`, `npx tsc --noEmit`) vengono eseguiti **prima** della modifica, per distinguere i fallimenti già esistenti.
3. **Implementazione** con la catena di worker del profilo.
4. **Verifica e auto-correzione.** Gli stessi comandi vengono rieseguiti. Se qualcosa che prima passava ora fallisce, lo **stesso** worker riprende la propria sessione con l’output dell’errore e corregge, fino a `maxCorrectionRounds` volte (default 2). Gli è vietato indebolire o cancellare test. I fallimenti già presenti prima vengono segnalati, ma non attribuiti al worker.
5. **Review indipendente** (large/critical). Il revisore riceve il **diff effettivo** della modifica e chiude con `VERDICT: PASS | MINOR | MAJOR`.
6. **Esito registrato** per l’apprendimento.

Se il task fallisce ancora dopo le correzioni, l’estensione **non** passa da sola a un modello più potente: di solito la causa è la guida (ambiguità, un dettaglio mancante), e deve correggerla il supervisore.

## Apprendimento

L’estensione non riaddestra i modelli, ma impara dai **propri risultati**. I dati stanno in `data/learning.json`: sono locali, non versionati e comuni a tutte le sessioni.

**Calibrazione dell’effort dei worker** (per profilo e modello):

- ogni delega registra se i test sono passati al primo colpo, quanti giri di correzione sono serviti e il verdetto della review;
- se la qualità scende sotto 0,7 su almeno 4 deleghe, l’effort **sale** di un livello (es. Sonnet `high` → `xhigh`);
- scende di un livello solo dopo **20 successi consecutivi al primo colpo, verificati da test reali**, al massimo un livello sotto `config.json`, e **mai** nei profili large/critical: la qualità viene prima dei token;
- dopo ogni cambio servono prove nuove (nessuna oscillazione); se modifichi `config.json`, il valore nuovo diventa la base.

**Lezioni del repository:** il supervisore registra con `record_lesson` le insidie specifiche e ricorrenti, per esempio *"eseguire `npm run build` prima di `npm test`"*. Da quel momento entrano nel prompt di ogni worker in quel repository (massimo 15; le duplicate rafforzano quella esistente).

**Suggerimento sul profilo:** se in un repository i task `medium` richiedono spesso correzioni, `plan_task` lo segnala e suggerisce il profilo superiore.

`/SupervisedCoding learning` mostra statistiche, efforts calibrati e lezioni. Con `learning forget <id>` si toglie una lezione, con `learning reset` si azzera tutto.

## Profili: modello ed effort per ogni situazione

| Profilo | Quando | Supervisore (effort) | Worker (in ordine) | Review indipendente |
|---|---|---|---|---|
| small | modifica locale o meccanica | medium | Sonnet 5 medium → Gemini → Opus 5.5 low | no |
| medium | lavoro normale, multi-file | medium | Sonnet 5 high → Opus 5.5 medium → Gemini | no |
| large | architettura, debugging difficile | high | Opus 5.5 high → Sonnet 5 xhigh → Gemini | Claude read-only, modello diverso |
| critical | sicurezza, concorrenza, migrazioni, complessità eccezionale | xhigh | **Fable 5.1 xhigh** (con autorizzazione) → Opus 5.5 xhigh → Gemini → Sonnet 5 max | famiglia diversa: Gemini via API (poi CLI), poi Claude |

- L’effort del supervisore segue il profilo del task aperto e torna a `medium` quando non c’è un task.
- Per una singola delega il supervisore può alzare o abbassare l’effort del worker (`effort`) quando quella modifica specifica lo richiede.
- La lunghezza minima della guida dipende dal profilo (small 150 caratteri, gli altri 400): nessun riempitivo sui task semplici.

## Modelli di punta: solo su autorizzazione

I modelli in `flagshipModels` (Claude Fable 5.1/5, GPT-6 Astra):

- sono ammessi **solo nel profilo critical**: la configurazione viene rifiutata se compaiono in altri profili;
- prima di usarli l’estensione chiede sempre:

  > Sarebbe più utile utilizzare **GPT-6 Astra** per questa task. Vuoi utilizzarlo? — **SI** / **No**

- **No**: si usa il modello successivo più potente non di punta (es. Opus 5.5 xhigh al posto di Fable, GPT-5.5 al posto di Astra);
- la risposta vale per tutto il task (correzioni, deleghe successive, failover): non viene chiesta due volte;
- un supervisore di punta approvato resta attivo finché il task è aperto; al task successivo si torna al supervisore normale;
- senza interfaccia (modalità non interattiva) la risposta è sempre No;
- se il modello di punta non ha crediti, la domanda non viene nemmeno fatta.

Non vengono mai usati modelli di punta per consultazioni o review.

## Crediti e failover

| Provider | Come si controllano i crediti |
|---|---|
| Claude Code | `rate_limit_event` a ogni chiamata (finestre 5h/7 giorni, reset, modelli fuori piano) + sonda Haiku all’attivazione |
| Supervisore Pi (Codex, Anthropic, Google) | header di limite nelle risposte + sonda minima all’attivazione |
| Gemini CLI | solo dagli errori (nessuna API di saldo) |

- I provider esauriti vengono saltati fino al reset (o per `exhaustedCooldownMinutes` se il reset non è noto); quelli oltre `creditHeadroom` (97%) passano in fondo alla coda. La soglia è alta di proposito: un task medio usa l’1–3% della finestra Claude e, se il limite arriva a metà lavoro, il failover passa il diff al worker successivo. Scansarsi troppo presto significa usare modelli più deboli e pagare token a consumo.
- Il blocco ha la granularità giusta: un modello fuori piano blocca solo quel modello, un limite Opus solo Opus, un limite dell’account tutto il provider.
- **Worker:** errore temporaneo → fino a 4 retry con attesa crescente; crediti, autenticazione o modello non disponibile → candidato successivo, con l’elenco dei file già modificati a metà; errore di coding → nessun cambio di modello, diagnosi del supervisore.
- **Supervisore:** su errore di crediti l’estensione cambia modello (`pi.setModel`) e riprende il turno da sola con un messaggio `[SUPERVISOR FAILOVER]`. Se non resta nessun supervisore, propone di completare il task aperto con i worker.
- Se scegli un modello a mano in Pi, la selezione passa a `manual` (il failover per crediti resta attivo). `/SupervisedCoding model auto` la riattiva.

## Tool del supervisore

| Tool | Scopo |
|---|---|
| `plan_task` | registra task e profilo, imposta l’effort del supervisore, per i task critical propone il supervisore di punta |
| `delegate_implementation` | implementazione tramite la catena del profilo, con failover e review automatica |
| `consult_readonly` | parere read-only mirato (Claude di default, Gemini se richiesto o in fallback) |
| `run_verification` | esegue un comando di test, typecheck, lint o build da `verificationCommands`; operatori shell rifiutati |
| `record_lesson` | registra una lezione del repository per i worker futuri |
| `supervisor_git` | ispezione Git read-only |
| `request_git_commit`, `request_git_push` | con conferma umana; niente merge né force-push |

## Sicurezza

- `allowedPaths` solo relativi, niente `..`, niente `.` nelle deleghe normali.
- Dopo ogni delega vengono controllati branch, HEAD, index e file modificati fuori allowlist.
- Claude editor con `--safe-mode --restricted`, allowlist di strumenti e comandi Git mutanti vietati. Claude read-only solo con `Read`, `Glob`, `Grep`.
- Timeout su worker, consulti e verifiche. Allo scadere viene terminato l’intero albero di processi (`taskkill /T` su Windows).
- `run_verification` accetta un solo comando semplice, con `CI=1` (i test runner non restano in watch mode), e segnala i file che il comando modifica.

## Configurazione (`config.json`, poi `/reload`)

| Campo | Significato |
|---|---|
| `autoVerify`, `maxCorrectionRounds` | verifica automatica prima/dopo e giri di auto-correzione |
| `reviewApi` | revisore via API di Pi (default Gemini 3.1 Pro): stessi risultati della CLI con una frazione dei token; `null` per disattivarlo |
| `repoRulesFiles`, `maxDiffBytes` | file di regole passati ai worker, dimensione massima del diff nelle review |
| `learning.enabled`, `learning.autoTuneEffort` | apprendimento e calibrazione automatica dell’effort |
| `supervisorChain` | `{provider, model}` in ordine di preferenza; sono considerati solo i modelli con autenticazione in Pi |
| `flagshipModels` | modelli di punta (solo critical, sempre con autorizzazione) |
| `supervisorEffort` | effort del supervisore per profilo (`default` = nessun task aperto) |
| `workerChains` | per profilo, `{worker, model, effort}` in ordine di preferenza (`model: ""` = default di Gemini CLI) |
| `independentReviewProfiles` | profili con review automatica |
| `minImplementationGuideChars` | lunghezza minima della guida per profilo |
| `verificationCommands`, `verificationTimeoutMinutes` | comandi ammessi in `run_verification` |
| `creditHeadroom`, `exhaustedCooldownMinutes`, `unavailableCooldownMinutes` | gestione dei crediti |
| `transientRetryAttempts`, `transientRetryDelayMs` | retry (attesa raddoppiata a ogni tentativo) |
| `workerTimeoutMinutes`, `consultTimeoutMinutes` | timeout (0 = nessuno) |
| `supervisorAutoSelect`, `supervisorFailover`, `probeOnActivate`, `claudeProbeModel` | selezione e controllo del supervisore |
| `automaticSupervisorRecovery`, `recoveryMaxAgeMinutes` | recovery quando non resta nessun supervisore |
| `worker*`, `claudeReadOnly*`, `supervisorTools`, `allowedSupervisorProviders`, `maxOutputBytes`, `contextWarningPercent` | permessi e limiti |

Le sessioni create con il nome precedente (`codex-claude-supervisor`) mantengono il loro stato.

## File

- `index.ts`: integrazione Pi (tool, comando, eventi, worker, verifica, review, selezione supervisore, modelli di punta);
- `lib.ts`: classificazione errori, lettura limiti, stato provider, ranking;
- `learning.ts`: esiti, calibrazione effort, lezioni, verdetti, estrazione comandi `VERIFY`;
- `tests/`: test unitari e d’integrazione (CLI Claude/Gemini simulate, host Pi simulato, repository Git reali);
- `data/learning.json`: dati di apprendimento (creato all’uso, escluso da Git).

La cartella è un repository Git: ogni modifica è visibile con `git diff` e reversibile.

## Test

```bash
node --test tests/lib.test.ts tests/learning.test.ts
node --import ./tests/resolve-pi.mjs --test tests/integration.test.ts
```

I test d’integrazione non usano modelli reali e non costano nulla. Coprono failover con passaggio del diff, auto-correzione, fallimenti preesistenti, diff e verdetto nella review, revisore API, regole e lezioni, calibrazione dell’effort, riuso della sessione, domanda SI/No sui modelli di punta e cambio del supervisore.
