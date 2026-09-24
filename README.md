# SupervisedCoding (Pi extension)

Estensione Pi per il coding supervisionato. Obiettivi, in ordine di priorità:

1. codice corretto, ben fatto e con meno errori possibili;
2. per ogni situazione, il modello e l’effort migliori;
3. nessuna interruzione quando un modello esaurisce i crediti: si passa al successivo;
4. il minor consumo di token possibile, ma **mai** a scapito della qualità;
5. la velocità è sempre secondaria.

Il **supervisore** (il modello attivo in Pi) esplora, pianifica, delega, verifica e accetta. I **worker** (Claude Code CLI, Gemini CLI) implementano. L’estensione sceglie i modelli, controlla i crediti e gestisce i failover.

## Installazione

Pi Agent scopre automaticamente ogni estensione presente come sottocartella di `~/.pi/agent/extensions/` (su Windows `%USERPROFILE%\.pi\agent\extensions\`): non serve registrarla altrove.

Requisiti: [Pi Agent](https://github.com/earendil-works) già installato e Node.js ≥ 22.16 (usato da Pi per eseguire l'estensione).

```bash
# macOS / Linux
git clone https://github.com/adgaudes/SupervisedCoding.git ~/.pi/agent/extensions/SupervisedCoding

# Windows (PowerShell)
git clone https://github.com/adgaudes/SupervisedCoding.git "$env:USERPROFILE\.pi\agent\extensions\SupervisedCoding"
```

(La repo è privata: `git clone` chiederà l'autenticazione GitHub, oppure usa `gh repo clone adgaudes/SupervisedCoding`.)

Il nome della cartella determina il nome del comando (`/SupervisedCoding`): non rinominarla dopo il primo uso, altrimenti le sessioni già create restano legate al vecchio nome (vedi nota più sotto sulle sessioni pregresse).

Poi, dentro la cartella clonata:

```bash
cd ~/.pi/agent/extensions/SupervisedCoding
npm install   # solo per test/typecheck in sviluppo; non richiesto per il funzionamento in Pi
```

Le dipendenze runtime (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) sono fornite dall'host Pi Agent stesso e non vanno installate separatamente.

Infine avvia o riavvia Pi Agent: la nuova estensione viene caricata automaticamente all'avvio. Se Pi è già in esecuzione, un `/reload` (o il riavvio della sessione) la rende disponibile. Verifica con:

```text
/SupervisedCoding on
```

che deve rispondere controllando i crediti disponibili e scegliendo il supervisore.

## Uso

```text
/SupervisedCoding on       attiva, controlla i crediti, sceglie il supervisore
/SupervisedCoding off      disattiva
/SupervisedCoding status   consumi per modello e per ruolo, spesa API riportata o stimata separata dagli abbonamenti, variazione osservata delle quote, qualità
/SupervisedCoding credits [refresh|reset]
/SupervisedCoding model [auto|manual]
/SupervisedCoding learning [forget <id>|reset]   cosa ha imparato l’estensione in questo repository
```

Dopo `on` basta descrivere il task. Per ogni nuovo task il supervisore:

1. legge solo i file e i simboli necessari per valutarlo;
2. classifica il task (`assessment`: tipo, rischio, incertezza, portata) e sceglie il profilo di complessità; chiama `plan_task` solo per task large/critical o che richiedono più deleghe, altrimenti passa profilo e assessment direttamente alla delega;
3. delega con `delegate_implementation` e una guida strutturata, con i comandi di verifica nella sezione `VERIFY`;
4. l’estensione esegue quei comandi prima e dopo la modifica e fa correggere al worker le eventuali regressioni (vedi sotto);
5. rivede il risultato (il diff della delega è già nel risultato, review indipendente) e usa `run_verification` solo per le verifiche che `VERIFY` non copre o che le modifiche successive hanno invalidato;
6. per correzioni o passi successivi dello stesso task riprende la sessione del worker, Claude o Gemini (`continuePrevious`);
7. chiude il task con `complete_task`: `accept` dopo aver rivisto diff e verifiche, `pause` se il lavoro resta incompleto;
8. quando scopre un’insidia ricorrente del repository la registra con `record_lesson`.

L’assessment può solo **alzare** il profilo scelto: sicurezza, concorrenza, migrazioni o rischio alto portano a critical; architettura, portata cross-system o incertezza alta ad almeno large; più file ad almeno medium.

## Ciclo di qualità

Per ogni delega:

1. **Contesto del repository.** Il worker riceve `AGENTS.md`/`CLAUDE.md` (in `--safe-mode` non li caricherebbe da solo) e le lezioni imparate in quel repository.
2. **Baseline.** I comandi di `VERIFY` presenti in `verificationCommands` (es. `npm test`, `npx tsc --noEmit`) vengono eseguiti **prima** della modifica, per distinguere i fallimenti già esistenti.
3. **Implementazione** con la catena di worker del profilo.
4. **Verifica e auto-correzione.** Gli stessi comandi vengono rieseguiti. Se qualcosa che prima passava ora fallisce, lo **stesso** worker riprende la propria sessione (Claude o Gemini) ricevendo solo l’output dell’errore, e corregge fino a `maxCorrectionRounds` volte (default 2). Gli è vietato indebolire o cancellare test. Se durante una correzione il worker esaurisce i crediti, la correzione passa al candidato successivo della catena con il diff del lavoro fatto. I fallimenti già presenti prima vengono segnalati ma non attribuiti al worker: l’esito è `unchanged_failures`, che non vale mai come successo.
5. **Review indipendente** (large/critical). Il revisore riceve il **diff di questa sola delega** (non quello cumulativo contro HEAD) e chiude con `VERDICT: PASS | MINOR | MAJOR`. Il revisore API viene usato solo se diff e file cambiati entrano completi nel materiale, altrimenti tocca a un revisore CLI, che può leggere il repository. Una review senza verdetto finale, o troncata dal limite di output, passa al revisore successivo. Un verdetto MAJOR rende fallita la delega.
6. **Esito registrato** per l’apprendimento. Conta come accettato solo dopo `complete_task` con `accept`, che il supervisore non può usare con regressioni aperte, verdetto MAJOR o, nei profili con review, senza review (salvo `manualReview` motivata).

Se il task fallisce ancora dopo le correzioni, l’estensione **non** passa da sola a un modello più potente: di solito la causa è la guida (ambiguità, un dettaglio mancante), e deve correggerla il supervisore.

## Apprendimento

L’estensione non riaddestra i modelli, ma impara dai **propri risultati**. I dati stanno in `data/learning.json`: sono locali, non versionati e comuni a tutte le sessioni. Più processi Pi aggiornano il file in modo serializzato (lock con rilettura), senza sovrascriversi a vicenda.

**Calibrazione dell’effort dei worker** (per repository, tipo di task, profilo e modello):

- ogni delega registra se i test sono passati al primo colpo, quanti giri di correzione sono serviti, il verdetto della review e, dopo `complete_task`, l’accettazione del supervisore;
- conta un solo campione per task (le deleghe dello stesso task sono correlate); i guasti dei provider e gli esiti più vecchi di 90 giorni sono esclusi;
- se la qualità scende sotto 0,7 su almeno 4 task, l’effort **sale** di un livello (es. Sonnet `high` → `xhigh`);
- scende di un livello solo dopo **20 task consecutivi accettati, riusciti al primo colpo e verificati da test reali**, al massimo un livello sotto `config.json`, e **mai** nei profili large/critical: la qualità viene prima dei token;
- dopo ogni cambio contano solo gli esiti registrati dopo il cambio (nessuna oscillazione); se modifichi `config.json`, il valore nuovo diventa la base;
- con `learning.autoTuneEffort: false` le calibrazioni salvate non vengono applicate.

**Ordine dei modelli** (`learning.autoRouteModels`, solo small/medium): nessuna esplorazione casuale sul lavoro reale. Un worker passa davanti al primo della catena solo se, in questo repository e per questo tipo di task, entrambi hanno almeno `learning.minModelSamples` (≥ 20) task accettati e riusciti al primo colpo, e il suo costo medio misurato è inferiore di almeno il 20%. Il risultato della delega riporta sempre il motivo dell’ordine usato (`Routing: …`).

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

- L’effort del supervisore segue il profilo del task su cui sta lavorando. Ogni nuovo prompt dell’utente riparte da `default` (`medium`) finché il supervisore non pianifica, delega o riprende un task; `complete_task` lo riporta a `default`.
- `supervisorProfiles` può indicare supervisori preferiti per un profilo (es. un modello più economico per small); negli altri casi vale `supervisorChain`.
- Per una singola delega il supervisore può alzare l’effort del worker (`effort`) quando quella modifica specifica lo richiede; abbassarlo è ammesso solo nel profilo small.
- Un task small, locale, meccanico o di documentazione, con rischio e incertezza bassi, usa effort `low` per il worker.
- La lunghezza minima della guida dipende dal profilo (small 150 caratteri, gli altri 400): nessun riempitivo sui task semplici.

## Modelli di punta: solo su autorizzazione

I modelli in `flagshipModels` (Claude Fable 5.1/5, GPT-6 Astra):

- sono ammessi **solo nel profilo critical**: la configurazione viene rifiutata se compaiono in altri profili;
- prima di usarli l’estensione chiede sempre:

  > Sarebbe più utile utilizzare **GPT-6 Astra** per questa task. Vuoi utilizzarlo? — **SI** / **No**

- **No**: si usa il modello successivo più potente non di punta (es. Opus 5.5 xhigh al posto di Fable, GPT-5.5 al posto di Astra);
- la risposta vale per tutto il task (correzioni, deleghe successive, failover): non viene chiesta due volte;
- un supervisore di punta approvato vale solo per quel task critical: ogni nuovo prompt riparte con il supervisore normale, e il supervisore di punta torna (senza nuova domanda) solo se il supervisore riprende lo stesso task; `complete_task` rilascia l’autorizzazione;
- senza interfaccia (modalità non interattiva) la risposta è sempre No;
- se il modello di punta non ha crediti, la domanda non viene nemmeno fatta.

Non vengono mai usati modelli di punta per consultazioni, review o sonde dei crediti.

## Crediti e failover

| Provider | Come si controllano i crediti |
|---|---|
| Claude Code | `rate_limit_event` a ogni chiamata (finestre 5h/7 giorni, reset, modelli fuori piano) + sonda Haiku all’attivazione |
| Supervisore Pi (Codex, Anthropic, Google) | header di limite nelle risposte + sonda minima all’attivazione, solo sul supervisore che verrebbe scelto (mai di punta) |
| Gemini CLI | solo dagli errori (nessuna API di saldo) |

- Le sonde partono solo se l’ultima lettura ha più di `probeTtlMinutes` (15) minuti; `credits refresh` le forza. Ogni sonda è limitata a `probeMaxTokens` e compare nei consumi di `status`.
- I provider esauriti vengono saltati fino al reset (o per `exhaustedCooldownMinutes` se il reset non è noto); quelli oltre `creditHeadroom` (97%) passano in fondo alla coda. La soglia è alta di proposito: un task medio usa l’1–3% della finestra Claude e, se il limite arriva a metà lavoro, il failover passa il diff al worker successivo. Scansarsi troppo presto significa usare modelli più deboli e pagare token a consumo.
- Il blocco ha la granularità giusta: un modello fuori piano blocca solo quel modello, un limite Opus solo Opus, un limite dell’account tutto il provider.
- **Worker:** errore temporaneo → fino a 4 retry con attesa crescente, riprendendo la sessione aperta dal tentativo fallito (o passando il diff se la sessione non è recuperabile), senza ripetere il lavoro già fatto; crediti, autenticazione o modello non disponibile → candidato successivo, con l’elenco dei file già modificati a metà; errore di coding → nessun cambio di modello, diagnosi del supervisore. Prima di ogni candidato la disponibilità viene ricontrollata: se un account si è esaurito durante la catena, i suoi altri modelli vengono saltati.
- **Supervisore:** su errore di crediti l’estensione cambia modello (`pi.setModel`) e riprende il turno da sola con un messaggio `[SUPERVISOR FAILOVER]`. Se non resta nessun supervisore, propone di completare il task aperto con i worker, attraverso la stessa pipeline di una delega normale (stesso profilo, baseline, auto-correzione, review); il risultato resta da accettare da parte del supervisore.
- Se scegli un modello a mano in Pi, la selezione passa a `manual` (il failover per crediti resta attivo). `/SupervisedCoding model auto` la riattiva.

## Budget per delega

- Ogni worker Claude riceve un limite di turni per profilo (`workerMaxTurns`, `--max-turns`).
- L’intera delega (baseline, implementazione, correzioni, review) ha una scadenza complessiva (`delegationTimeoutMinutes`, default 120) e, se impostato, un tetto di costo cumulativo (`delegationBudgetUsd`, 0 = disattivato), passato a Claude come `--max-budget-usd` residuo.
- Raggiunto un limite, la delega si ferma **senza** passare a un altro modello: il lavoro fatto resta nel working tree e decide il supervisore. Un limite dell’estensione non è un credito esaurito del provider.
- L’output dei processi è limitato in memoria (`maxProcessOutputBytes`), la review API a `reviewMaxTokens`.
- `status` segnala le invocazioni senza dati d’uso (totali incompleti, non costo zero). Ogni invocazione viene anche registrata in `data/usage.jsonl`, con task, ruolo, provider, modello, billing e consumi per modello.

## Tool del supervisore

| Tool | Scopo |
|---|---|
| `plan_task` | registra task, profilo e assessment per task large/critical o con più deleghe; imposta l’effort del supervisore, per i task critical propone il supervisore di punta |
| `delegate_implementation` | implementazione tramite la catena del profilo, con failover e review automatica; accetta profilo e assessment anche senza `plan_task` |
| `complete_task` | `accept` chiude il task e lo registra come accettato; `pause` lo lascia aperto per un seguito. Entrambi rilasciano il supervisore di punta e riportano l’effort a `default` |
| `consult_readonly` | parere read-only mirato (Claude di default, Gemini se richiesto o in fallback) |
| `run_verification` | esegue un comando di test, typecheck, lint o build da `verificationCommands` non già eseguito da `VERIFY`; operatori shell rifiutati; se fallisce, il task risulta fallito finché una nuova delega non lo sistema |
| `record_lesson` | registra una lezione del repository per i worker futuri |
| `supervisor_git` | ispezione Git read-only |
| `request_git_commit`, `request_git_push` | con conferma umana; niente merge né force-push |

## Sicurezza

- `allowedPaths` solo relativi, niente `..`, niente `.` nelle deleghe normali.
- `allowedPaths` è un vincolo del prompt verificato **dopo** l’esecuzione, non un recinto del filesystem: dopo ogni delega vengono controllati branch, HEAD, index e file modificati fuori allowlist. File ignorati da Git e scritture fuori dal repository non rientrano in questo controllo.
- Claude editor con `--safe-mode --restricted`, allowlist di strumenti e comandi Git mutanti vietati. Claude read-only solo con `Read`, `Glob`, `Grep`.
- Timeout su worker, consulti e verifiche. Allo scadere viene terminato l’intero albero di processi (`taskkill /T` su Windows).
- `run_verification` accetta un solo comando semplice, con `CI=1` (i test runner non restano in watch mode), e segnala i file che il comando modifica.

## Configurazione (`config.json`, poi `/reload`)

| Campo | Significato |
|---|---|
| `autoVerify`, `maxCorrectionRounds` | verifica automatica prima/dopo e giri di auto-correzione |
| `reviewApi` | revisore via API di Pi (default Gemini 3.1 Pro), senza l’overhead fisso di una CLI; usato solo con materiale completo, mai un modello di punta; `null` per disattivarlo |
| `repoRulesFiles`, `maxDiffBytes` | file di regole passati ai worker, dimensione massima del diff nelle review |
| `learning.enabled`, `learning.autoTuneEffort` | apprendimento e calibrazione automatica dell’effort |
| `learning.autoRouteModels`, `learning.minModelSamples` | riordino dei worker su evidenze misurate (≥ 20 task) |
| `supervisorChain` | `{provider, model}` in ordine di preferenza; sono considerati solo i modelli con autenticazione in Pi |
| `supervisorProfiles` | supervisori preferiti per profilo, prima di `supervisorChain` |
| `probeTtlMinutes`, `probeMaxTokens` | validità di una lettura dei crediti e limite di output delle sonde |
| `workerMaxTurns`, `delegationTimeoutMinutes`, `delegationBudgetUsd` | budget per delega (vedi sopra) |
| `reviewMaxTokens`, `maxProcessOutputBytes` | limiti di output di review API e processi |
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
- `routing.ts`: assessment del task e ordine dei worker basato su evidenze;
- `changes.ts`: checkpoint dei file autorizzati e diff della singola delega;
- `AUDIT.md`: audit del 24 settembre 2026 da cui derivano le correzioni A1–A12;
- `tests/`: test unitari, d’integrazione e di regressione dell’audit (CLI Claude/Gemini simulate, host Pi simulato, repository Git reali);
- `data/learning.json`, `data/usage.jsonl`: dati di apprendimento e registro delle invocazioni (creati all’uso, esclusi da Git).

La cartella è un repository Git: ogni modifica è visibile con `git diff` e reversibile.

## Test

```bash
npm install
npm test        # unitari, integrazione, regressioni dell'audit, typecheck
```

I test d’integrazione non usano modelli reali e non costano nulla. Coprono failover con passaggio del diff, auto-correzione (anche con failover e ripresa di sessioni Claude e Gemini), fallimenti preesistenti, diff della singola delega e verdetto nella review, revisore API e review troncate, regole e lezioni, calibrazione dell’effort, riuso della sessione, retry con ripresa, limiti di turni e timeout, contabilità di sonde e consumi Gemini, chiusura del task con `complete_task`, domanda SI/No sui modelli di punta e cambio del supervisore.
