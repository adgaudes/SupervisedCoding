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
/SupervisedCoding status   stato, task, metriche, token/costi, crediti
/SupervisedCoding credits [refresh|reset]
/SupervisedCoding model [auto|manual]
```

Dopo `on` basta descrivere il task. Per ogni nuovo task il supervisore:

1. legge solo i file e i simboli necessari per valutarlo;
2. chiama `plan_task` con il profilo di complessità;
3. delega con `delegate_implementation` e una guida strutturata;
4. rivede diff-stat e diff mirati, poi conferma con `run_verification` (test, typecheck, lint);
5. per le correzioni riprende la sessione del worker (`continuePrevious`), senza ripianificare.

## Profili: modello ed effort per ogni situazione

| Profilo | Quando | Supervisore (effort) | Worker (in ordine) | Review indipendente |
|---|---|---|---|---|
| small | modifica locale o meccanica | medium | Sonnet 5 medium → Gemini → Opus 5.5 low | no |
| medium | lavoro normale, multi-file | medium | Sonnet 5 high → Opus 5.5 medium → Gemini | no |
| large | architettura, debugging difficile | high | Opus 5.5 high → Sonnet 5 xhigh → Gemini | Claude read-only, modello diverso |
| critical | sicurezza, concorrenza, migrazioni, complessità eccezionale | xhigh | **Fable 5.1 xhigh** (con autorizzazione) → Opus 5.5 xhigh → Gemini → Sonnet 5 max | famiglia diversa (Gemini), poi Claude |

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

- I provider esauriti vengono saltati fino al reset (o per `exhaustedCooldownMinutes` se il reset non è noto); quelli oltre `creditHeadroom` (90%) passano in fondo alla coda.
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

- `index.ts`: integrazione Pi (tool, comando, eventi, esecuzione worker, selezione supervisore, modelli di punta);
- `lib.ts`: logica pura (classificazione errori, lettura limiti, stato provider, ranking);
- `tests/lib.test.ts`: test (`node --test tests/lib.test.ts`) con i messaggi reali di Codex, Anthropic e Claude Code;
- `config.json`, `README.md`.
