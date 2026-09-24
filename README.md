# SupervisedCoding (Pi extension)

Estensione Pi per il coding supervisionato. Obiettivi, in ordine di priorità:

1. codice corretto, ben fatto e con meno errori possibili;
2. per ogni situazione, il modello e l’effort migliori;
3. nessuna interruzione quando un modello esaurisce i crediti: si passa al successivo;
4. il minor consumo di token possibile, ma **mai** a scapito della qualità;
5. la velocità è sempre secondaria.

Il **supervisore** (il modello attivo in Pi) esplora, pianifica, delega, verifica e accetta. I **worker** implementano, i **revisori** controllano. L’estensione sceglie i modelli, controlla i crediti e gestisce i failover.

**Nessun modello ha un ruolo fisso.** Claude, GPT e Gemini possono supervisionare, implementare e rivedere; chi fa cosa dipende dal task (vedi [Come si scelgono modello ed effort](#come-si-scelgono-modello-ed-effort)). I worker girano con tre strumenti: Claude Code CLI (modelli Claude), Gemini CLI e la CLI di Pi stessa, che esegue **qualsiasi modello configurato in Pi** (per esempio i GPT dell’abbonamento OpenAI Codex).

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

1. **Contesto del repository.** Il worker riceve `AGENTS.md`/`CLAUDE.md` (in `--safe-mode` non li caricherebbe da solo) della radice e di ogni cartella lungo il percorso dei file autorizzati, più le lezioni imparate in quel repository. Se il limite di 12 KB costringe a ometterne qualcuno, il worker viene avvisato di leggerli.
2. **Baseline.** I comandi di `VERIFY` presenti in `verificationCommands` (es. `npm test`, `npx tsc --noEmit`) vengono eseguiti **prima** della modifica, per distinguere i fallimenti già esistenti. La baseline vale per l’intero **task**: un controllo è "già fallito" solo se era rosso anche quando il task è iniziato. Ciò che una delega precedente dello stesso task ha rotto resta una regressione da correggere.
3. **Implementazione** con la catena di worker del profilo.
4. **Verifica e auto-correzione.** Gli stessi comandi vengono rieseguiti. Se qualcosa che prima passava ora fallisce, lo **stesso** worker riprende la propria sessione (Claude o Gemini) ricevendo solo l’output dell’errore, e corregge fino a `maxCorrectionRounds` volte (default 2). Gli è vietato indebolire o cancellare test. Se durante una correzione il worker esaurisce i crediti, la correzione passa al candidato successivo della catena con il diff del lavoro fatto. I fallimenti già presenti all’inizio del task vengono segnalati ma non attribuiti al worker: l’esito è `unchanged_failures`, che non vale mai come successo.
5. **Review indipendente** (large/critical). Il revisore riceve il **diff di questa sola delega** (non quello cumulativo contro HEAD) e chiude con `VERDICT: PASS | MINOR | MAJOR`. Il revisore API viene usato solo se diff e file cambiati entrano completi nel materiale, altrimenti tocca a un revisore CLI, che può leggere il repository. Un revisore che non produce un verdetto completo (errore, limite di turni, output troncato, verdetto mancante) passa la mano al successivo. Il modello dell’implementatore rivede solo come ultima risorsa, dopo l’altra famiglia. Un verdetto MAJOR rende fallita la delega.
6. **Accettazione** con `complete_task`. Il supervisore non può accettare con regressioni aperte o verdetto MAJOR. Se il task ha avuto più deleghe, o l’ultima non è stata rivista, e il suo profilo più alto richiede la review, `complete_task` fa rivedere il **diff dell’intero task** prima di accettare: con MAJOR il task non viene accettato, e senza review disponibile serve `manualReview` motivata.
7. **Esito registrato** per l’apprendimento; conta come accettato solo dopo `complete_task` con `accept`.

Se il task fallisce ancora dopo le correzioni, l’estensione **non** passa da sola a un modello più potente: di solito la causa è la guida (ambiguità, un dettaglio mancante), e deve correggerla il supervisore.

## Apprendimento

L’estensione non riaddestra i modelli, ma impara dai **propri risultati**. I dati stanno in `data/learning.json`: sono locali, non versionati e comuni a tutte le sessioni. Più processi Pi aggiornano il file in modo serializzato (lock con rilettura), senza sovrascriversi a vicenda.

**Calibrazione dell’effort dei worker** (per repository, tipo di task, profilo e modello):

- ogni delega registra se i test sono passati al primo colpo, quanti giri di correzione sono serviti, il verdetto della review e, dopo `complete_task`, l’accettazione del supervisore. L’esito va al modello che ha fatto il lavoro, anche se una correzione è poi passata a un altro modello per crediti esauriti;
- conta un solo campione per task (le deleghe dello stesso task sono correlate), con la qualità della sua delega **peggiore**: un fallimento rimediato con un’altra delega resta un fallimento. I guasti dei provider, gli arresti per i limiti di tempo o costo della delega e gli esiti più vecchi di 90 giorni sono esclusi;
- se la qualità scende sotto 0,7 su almeno 4 task di **qualsiasi tipo** nel repository, l’effort **sale** di un livello (es. Sonnet `high` → `xhigh`): un modello in difficoltà va aiutato subito;
- scende di un livello solo dopo **20 task consecutivi dello stesso tipo, accettati, con ogni delega riuscita al primo colpo e verificata da test reali**, al massimo un livello sotto `config.json`, e **mai** nei profili large/critical: la qualità viene prima dei token;
- dopo ogni cambio contano solo gli esiti registrati dopo il cambio (nessuna oscillazione); se modifichi `config.json`, il valore nuovo diventa la base;
- con `learning.autoTuneEffort: false` le calibrazioni salvate non vengono applicate.

**Ordine dei modelli** (`learning.autoRouteModels`, solo small/medium): nessuna esplorazione casuale sul lavoro reale. Un worker passa davanti al primo della catena solo se, in questo repository e per questo tipo di task, entrambi hanno almeno `learning.minModelSamples` (≥ 20) task accettati e riusciti al primo colpo, e il suo costo medio misurato è inferiore di almeno il 20%. Il risultato della delega riporta sempre il motivo dell’ordine usato (`Routing: …`).

**Lezioni del repository:** il supervisore registra con `record_lesson` le insidie specifiche e ricorrenti, per esempio *"eseguire `npm run build` prima di `npm test`"*. Da quel momento entrano nel prompt di ogni worker in quel repository (massimo 15; le duplicate rafforzano quella esistente).

**Suggerimento sul profilo:** se in un repository i task `medium` richiedono spesso correzioni, `plan_task` lo segnala e suggerisce il profilo superiore.

`/SupervisedCoding learning` mostra statistiche, efforts calibrati e lezioni. Con `learning forget <id>` si toglie una lezione, con `learning reset` si azzera tutto.

## Come si scelgono modello ed effort

La decisione è divisa: **il supervisore** (un modello) classifica il task, **l’estensione** sceglie modelli ed effort con regole deterministiche.

1. **Classificazione.** Il supervisore sceglie profilo e assessment (tipo, rischio, incertezza, portata); le regole dell’assessment possono solo alzare il profilo. Il supervisore del primo turno si sceglie prima di conoscere il task: è il primo modello disponibile di `supervisorChain`, oggi **GPT-5.5**. GPT-6 Astra lo precede solo con autorizzazione nei task critical; se GPT-5.5 esaurisce i crediti si passa al successivo della catena.
2. **Idoneità e ordine iniziale.** Per ogni profilo `workerChains` elenca i modelli idonei, di qualsiasi famiglia, in ordine di qualità, ognuno con il suo effort. È un giudizio iniziale, non una misura: vale finché mancano evidenze nel repository.
3. **Filtri a ogni scelta.** Crediti: i modelli esauriti vengono saltati, quelli oltre il 97% della quota vanno in fondo. Autorizzazione per i modelli di punta. Il revisore è sempre un modello diverso dall’implementatore, prima di un’altra famiglia. Dentro un task supervisore e implementatore restano gli stessi, salvo guasti del provider.
4. **Effort.** Parte da `config.json`. Un task small meccanico o di documentazione, a basso rischio, scende a `low`. Il supervisore può alzarlo per una delega. L’apprendimento lo alza quando la qualità cala e lo abbassa, prudentemente, dopo lunghe serie pulite (vedi [Apprendimento](#apprendimento)).
5. **Modello più forte (escalation).** Se il primo modello va male anche al suo effort più alto, o non ha un effort da alzare, su almeno 4 task dello stesso tipo nel repository, passa davanti il primo candidato che non è in difficoltà. Vale per tutti i profili.
6. **Risparmio.** Solo per small/medium, un modello passa davanti se costa almeno il 20% in meno con qualità misurata equivalente (vedi [Apprendimento](#apprendimento)).

Il risultato di ogni delega riporta il motivo dell’ordine usato (`Routing: …`).

## Profili: ordine iniziale

| Profilo | Quando | Effort supervisore | Worker (ordine iniziale) | Review indipendente |
|---|---|---|---|---|
| small | modifica locale o meccanica | medium | Sonnet 5 medium → GPT-6 Sol medium → Gemini 3.1 Pro → Opus 5.5 low | no |
| medium | lavoro normale, multi-file | medium | Sonnet 5 high → GPT-5.5 high → Opus 5.5 medium → Gemini 3.1 Pro | no |
| large | architettura, debugging difficile | high | Opus 5.5 high → GPT-5.5 xhigh → Sonnet 5 xhigh → Gemini 3.1 Pro | sì |
| critical | sicurezza, concorrenza, migrazioni, complessità eccezionale | xhigh | **Fable 5.1 xhigh** → **GPT-6 Astra xhigh** (entrambi con autorizzazione) → Opus 5.5 xhigh → GPT-5.5 xhigh → Gemini 3.1 Pro → Sonnet 5 max | sì |

Perché quest’ordine:
- **Claude davanti** dove conta lo strumento: Claude Code permette di autorizzare solo i comandi di verifica, quindi il worker esegue i test da solo prima di consegnare.
- **Il secondo è quasi sempre un GPT**, su un abbonamento diverso: se finisce la finestra Claude, che è condivisa da Sonnet e Opus, il lavoro continua senza fermarsi.
- **GPT-6 Sol nei task small:** costa meno di GPT-5.5 ($2/$10 contro $5/$30 per milione di token, secondo il catalogo di Pi). Non ci sono misure sulla sua qualità: è l’apprendimento a confermarlo o a scavalcarlo.

**Revisori:** tutti i modelli non di punta delle catene del profilo e dei profili superiori. Prima quelli di un’altra famiglia rispetto all’implementatore, poi gli altri della stessa famiglia, e il modello dell’implementatore solo per ultimo. Il revisore API (`reviewApi`) viene provato per primo nella sua famiglia, perché costa meno, ma solo con materiale completo.

- L’effort del supervisore segue il profilo del task su cui sta lavorando. Un task non finito (pianificato o fallito) lo conserva nel prompt successivo. Un task già implementato ma non accettato, o messo in pausa, no: il nuovo prompt riparte da `default` (`medium`) finché il supervisore non delega o riprende un task. `complete_task` lo riporta a `default`.
- `supervisorProfiles` (vuoto di default) può indicare supervisori preferiti per un profilo. Attenzione: ogni cambio di modello del supervisore rilegge l’intera conversazione senza cache del prompt; conviene usarlo solo dopo averne misurato il vantaggio. `complete_task` non cambia mai modello prima della risposta finale.
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
- un supervisore di punta approvato vale solo per quel task critical. Resta attivo nel prompt successivo finché il task non è finito (pianificato o fallito). Se invece il task è già implementato, il nuovo prompt riparte con il supervisore normale, e quello di punta torna, senza nuova domanda, solo se il supervisore riprende lo stesso task. `complete_task` rilascia l’autorizzazione;
- senza interfaccia (modalità non interattiva) la risposta è sempre No;
- se il modello di punta non ha crediti, la domanda non viene nemmeno fatta.

Non vengono mai usati modelli di punta per consultazioni, review o sonde dei crediti.

## Crediti e failover

| Provider | Come si controllano i crediti |
|---|---|
| Claude Code | `rate_limit_event` a ogni chiamata (finestre 5h/7 giorni, reset, modelli fuori piano) + sonda Haiku all’attivazione |
| Supervisore Pi (Codex, Anthropic, Google) | header di limite nelle risposte + sonda minima all’attivazione, solo sul supervisore che verrebbe scelto (mai di punta) |
| Gemini CLI | solo dagli errori (nessuna API di saldo) |
| Worker e revisori via Pi (es. GPT) | dagli errori; condividono lo stato dell’account con il supervisore dello stesso provider |

- Le sonde partono solo se l’ultima lettura ha più di `probeTtlMinutes` (15) minuti; `credits refresh` le forza. Ogni sonda è limitata a `probeMaxTokens` e compare nei consumi di `status`.
- I provider esauriti vengono saltati fino al reset (o per `exhaustedCooldownMinutes` se il reset non è noto); quelli oltre `creditHeadroom` (97%) passano in fondo alla coda. La soglia è alta di proposito: un task medio usa l’1–3% della finestra Claude e, se il limite arriva a metà lavoro, il failover passa il diff al worker successivo. Scansarsi troppo presto significa usare modelli più deboli e pagare token a consumo.
- Il blocco ha la granularità giusta: un modello fuori piano blocca solo quel modello, un limite Opus solo Opus, un limite dell’account tutto il provider.
- **Worker:** errore temporaneo → fino a 4 retry con attesa crescente, riprendendo la sessione aperta dal tentativo fallito (o passando il diff se la sessione non è recuperabile), senza ripetere il lavoro già fatto; crediti, autenticazione o modello non disponibile → candidato successivo, con l’elenco dei file già modificati a metà; errore di coding → nessun cambio di modello, diagnosi del supervisore. Prima di ogni candidato la disponibilità viene ricontrollata: se un account si è esaurito durante la catena, i suoi altri modelli vengono saltati.
- **Supervisore:** su errore di crediti l’estensione cambia modello (`pi.setModel`) e riprende il turno da sola con un messaggio `[SUPERVISOR FAILOVER]`. Se non resta nessun supervisore, propone di completare il task aperto con i worker, attraverso la stessa pipeline di una delega normale (stesso profilo, baseline, auto-correzione, review); il risultato resta da accettare da parte del supervisore.
- Se scegli un modello a mano in Pi, la selezione passa a `manual` (il failover per crediti resta attivo). `/SupervisedCoding model auto` la riattiva.

## Budget per delega

- Ogni worker e ogni revisore riceve un limite di turni per profilo (`workerMaxTurns`: small 40, medium 80, large 120, critical 160): `--max-turns` per Claude Code; per i modelli via Pi, che non ha un flag equivalente, l’estensione conta i turni e ferma il processo. Sono valori prudenziali, da ritarare su misure reali.
- L’intera delega (baseline, implementazione, correzioni, review) ha una scadenza complessiva (`delegationTimeoutMinutes`, default 120) e, se impostato, un tetto di costo cumulativo (`delegationBudgetUsd`, 0 = disattivato), passato a Claude come `--max-budget-usd` residuo. Scadenza e tetto vengono controllati **tra una fase e l’altra**: un worker in esecuzione non viene mai interrotto per questo, ma dopo il limite non partono nuovi tentativi, correzioni o review. Una review saltata viene fatta da `complete_task`.
- Raggiunto un limite, la delega si ferma **senza** passare a un altro modello: il lavoro fatto resta nel working tree e **la sessione del worker resta riprendibile**. Il supervisore vede lo stato e fa finire il lavoro alla stessa sessione con `continuePrevious=true`, senza rifare l’esplorazione. Un limite dell’estensione non è un credito esaurito del provider.
- L’output dei processi è limitato in memoria (`maxProcessOutputBytes`), la review API a `reviewMaxTokens`.
- `status` segnala le invocazioni avviate senza dati d’uso (totali incompleti, non costo zero). Ogni invocazione viene anche registrata in `data/usage.jsonl`, con task, ruolo, provider, modello, billing e consumi per modello; oltre 5 MB il file ruota in `usage.jsonl.1`.

## Tool del supervisore

| Tool | Scopo |
|---|---|
| `plan_task` | registra task, profilo e assessment per task large/critical o con più deleghe; imposta l’effort del supervisore, per i task critical propone il supervisore di punta |
| `delegate_implementation` | implementazione tramite la catena del profilo, con failover e review automatica; accetta profilo e assessment anche senza `plan_task` |
| `complete_task` | `accept` chiude il task e lo registra come accettato, dopo la review dell’intero task quando serve; `pause` lo lascia aperto per un seguito. Entrambi rilasciano il supervisore di punta e riportano l’effort a `default` |
| `consult_readonly` | parere read-only mirato di qualsiasi modello; `reviewer` sceglie la famiglia preferita (`claude`, `gpt`, `gemini`), le altre seguono se non disponibile |
| `run_verification` | esegue un comando di test, typecheck, lint o build da `verificationCommands` non già eseguito da `VERIFY`; operatori shell rifiutati; se fallisce, il task aperto risulta fallito finché una nuova delega non lo sistema (salvo che quel controllo fosse rosso già all’inizio del task; un task accettato non viene riaperto) |
| `record_lesson` | registra una lezione del repository per i worker futuri |
| `supervisor_git` | ispezione Git read-only |
| `request_git_commit`, `request_git_push` | con conferma umana; niente merge né force-push |

## Sicurezza

- `allowedPaths` solo relativi, niente `..`, niente `.` nelle deleghe normali.
- `allowedPaths` è un vincolo del prompt verificato **dopo** l’esecuzione, non un recinto del filesystem: dopo ogni delega vengono controllati branch, HEAD, index e file modificati fuori allowlist. File ignorati da Git e scritture fuori dal repository non rientrano in questo controllo.
- Claude editor con `--safe-mode --restricted`, allowlist di strumenti e comandi Git mutanti vietati. Claude read-only solo con `Read`, `Glob`, `Grep`.
- Worker via Pi con `--no-extensions --no-skills --no-context-files --no-approve`: SupervisedCoding non si carica nel worker, le regole arrivano dal prompt. Di default **senza terminale** (`piWorkerTools`: read, edit, write, grep, find, ls), perché Pi non può limitare la shell ai soli comandi di verifica: i test li esegue l’estensione. In sola lettura: read, grep, find, ls. Le sessioni dei worker Pi stanno in `data/pi-sessions`.
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
| `workerChains` | per profilo, i modelli idonei in ordine iniziale di qualità: `{worker: "claude", model, effort}`, `{worker: "gemini", model}` (`model: ""` = default di Gemini CLI) o `{worker: "pi", provider, model, effort}` per qualsiasi modello di Pi |
| `piCommand`, `piCommandArgs`, `piWorkerTools`, `piReadOnlyTools` | CLI di Pi per i worker (`pi` = l’installazione che esegue l’estensione) e strumenti concessi |
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

- `index.ts`: integrazione Pi (tool, comando, eventi, worker Claude/Gemini/Pi, verifica, review, selezione supervisore, modelli di punta);
- `lib.ts`: classificazione errori, lettura limiti, stato provider, ranking;
- `learning.ts`: esiti, calibrazione effort, lezioni, verdetti, estrazione comandi `VERIFY`;
- `routing.ts`: assessment del task, escalation e ordine dei worker basato su evidenze;
- `changes.ts`: checkpoint dei file autorizzati e diff della singola delega;
- `AUDIT.md`, `AUDIT-2.md`: i due audit del 24 settembre 2026 da cui derivano le correzioni A1–A12 e B1–B13;
- `tests/`: test unitari, d’integrazione e di regressione dell’audit (CLI Claude/Gemini simulate, host Pi simulato, repository Git reali);
- `data/learning.json`, `data/usage.jsonl`: dati di apprendimento e registro delle invocazioni (creati all’uso, esclusi da Git).

La cartella è un repository Git: ogni modifica è visibile con `git diff` e reversibile.

## Test

```bash
npm install
npm test        # unitari, integrazione, regressioni dell'audit, typecheck
```

I test d’integrazione non usano modelli reali e non costano nulla. Coprono failover con passaggio del diff, auto-correzione (anche con failover e ripresa di sessioni Claude e Gemini), fallimenti preesistenti, diff della singola delega e verdetto nella review, revisore API e review troncate, regole e lezioni, calibrazione dell’effort, riuso della sessione, retry con ripresa, limiti di turni e timeout, contabilità di sonde e consumi Gemini, chiusura del task con `complete_task`, domanda SI/No sui modelli di punta e cambio del supervisore.
