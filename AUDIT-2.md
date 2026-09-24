**Secondo audit SupervisedCoding — 24 settembre 2026**

Revisione analizzata: `06663eb` (dopo le correzioni A1–A12 del primo audit, `AUDIT.md`). Letti integralmente `index.ts`, `lib.ts`, `learning.ts`, `routing.ts`, `changes.ts` e `config.json`. Verificati i flag usati contro le CLI installate: Claude Code 2.1.281 e Gemini CLI 0.61.0. Nessuna chiamata a modelli reali. Codice operativo e configurazione non modificati.

> **Stato (dopo l'audit).** B1–B13 sono stati corretti come proposto qui sotto. Le dieci riproduzioni sono diventate test di regressione del comportamento corretto, insieme ad altri test per B7, B9 e B13 (`tests/regressions.test.ts`, test "AUDIT-2 …"; `audit/reproduce-2.test.ts` li importa soltanto). Sul codice di `06663eb` falliscono tutti e 17. Per B3 i limiti di turni di default sono stati alzati a 40/80/120/160 in attesa di misure reali, e le lezioni non vengono filtrate per pertinenza (vedi la nota di stato in `AUDIT.md`). La descrizione sotto si riferisce al codice di `06663eb`.

Ogni rilievo è valutato rispetto agli obiettivi del README, in ordine di priorità: (1) codice corretto con meno errori possibili; (2) modello ed effort giusti per ogni situazione; (3) nessuna interruzione per crediti esauriti; (4) token minimi, mai a scapito della qualità; (5) velocità secondaria.

**Giudizio**

L'impianto regge e le correzioni del primo audit sono in gran parte solide: diff della singola delega, failover nelle correzioni, ripresa di sessione nei retry e per Gemini, contabilità più onesta, sonde limitate. I problemi rimasti non sono più nei singoli meccanismi, ma nel modo in cui interagiscono lungo un task con più deleghe o più prompt:

- la baseline dei test viene rifatta a ogni delega, e questo può nascondere regressioni introdotte dal task stesso;
- la calibrazione considera solo l'ultima delega di ogni task;
- i limiti introdotti per A10 interrompono il lavoro e buttano via la sessione del worker.

Sono i punti da correggere prima di fidarsi dell'accettazione e dell'apprendimento automatici.

**Verifiche eseguite**

| Verifica | Risultato |
|---|---|
| `npm test` (unitari, integrazione, regressioni, typecheck) | 22 + 12 + 18 test passati, typecheck pulito |
| Flag Claude Code 2.1.281 | `--max-turns` supportato ma nascosto dall'help (`hideHelp`); `--max-budget-usd`, `--safe-mode`, `--restricted`, `--permission-prompts` presenti; i subtype `error_max_turns` ed `error_max_budget_usd` esistono nel binario |
| Flag Gemini CLI 0.61.0 | `--resume` accetta `latest`, un indice **o un UUID completo**: il resume per `session_id` (A9) è compatibile |
| Riproduzioni in `audit/reproduce-2.test.ts` | 10 casi confermati con host Pi e CLI simulate |

Come nel primo audit, le riproduzioni **asseriscono il comportamento difettoso attuale**: vanno trasformate in test di regressione quando si correggono i rilievi.

```powershell
node --import ./tests/resolve-pi.mjs --test audit/reproduce-2.test.ts
```

**Priorità**

| ID | Priorità | Obiettivo | Riscontro | Riprodotto |
|---|---|---|---|---|
| B1 | P1 | 1 | Baseline rifatta a ogni delega: le regressioni lasciate da una delega precedente dello stesso task diventano "già presenti" e il task si può accettare | sì |
| B2 | P1 | 1, 2 | La calibrazione usa solo l'ultima delega di ogni task: i fallimenti corretti con una nuova delega spariscono | sì |
| B3 | P1 | 1, 3, 4 | Limite di turni raggiunto: delega interrotta, sessione persa, nessun esito registrato | sì |
| B4 | P1 | 1, 3, 4 | Scadenza complessiva di 120 minuti, più corta della somma dei timeout che la compongono; uccide il worker come un abort generico | sì |
| B5 | P2 | 1 | Un revisore che fallisce per motivi non di provider (es. limite di 30 turni) chiude la catena: nessuna review | sì |
| B6 | P2 | 4 | Cambi di modello del supervisore dentro un task (profili small, task critical su più prompt): cache del prompt persa a ogni cambio | sì (small) |
| B7 | P2 | 1 | Review solo sul delta dell'ultima delega; l'accettazione considera solo l'ultima delega | da codice |
| B8 | P2 | 2 | Dopo un failover in correzione, l'intero esito viene attribuito al modello subentrato | sì |
| B9 | P2 | 2 | Evidenze di calibrazione frammentate per 11 tipi di task: gli aumenti di effort scattano raramente | da codice |
| B10 | P3 | 1 | Nell'ordine dei revisori large, il modello dell'implementatore viene prima dell'altra famiglia | sì |
| B11 | P3 | 1 | `run_verification` fallito segna come fallito anche un task già accettato, o un fallimento preesistente | sì |
| B12 | P3 | 3 | `minutes()` usato per durate che non sono timeout: il cooldown di 24 h diventa ≤ 2 h, e può lanciare un'eccezione | sì |
| B13 | P3 | vari | Rifiniture: etichette, codice morto, crescita dei log, verdetto molto rigido | da codice |

---

**B1 — La baseline di ogni delega assorbe le regressioni del task stesso**

Riferimenti: `index.ts:2325` (baseline), `index.ts:2364` (esito), `index.ts:2191` (`complete_task`).

La baseline dei comandi `VERIFY` viene ricalcolata all'inizio di **ogni** delega. Se la delega 1 rompe un test e i giri di correzione non bastano, il task resta `failed`. Il supervisore delega di nuovo (`continuePrevious`). La baseline della delega 2 vede già il test rosso e lo classifica "già fallito prima della modifica". Quindi il worker non riceve giri di correzione, l'esito è `unchanged_failures`, la fase torna `implemented` e `complete_task accept` è permesso.

Riprodotto (B1): delega 1 porta `value.txt` a `bad` (verifica `failed`); delega 2 dello stesso task tocca solo un altro file; il report dice *"FAIL (was already failing before the change)"* e l'accettazione riesce.

Lo stesso accade nel recovery senza supervisore, che riesegue la delega dopo un fallimento, e dopo un `run_verification` fallito.

Correzione: una baseline **per task**, presa alla prima delega e conservata nel `TaskPacket`. Le deleghe successive confrontano i controlli con quella. Un controllo verde all'inizio del task e rosso ora è una regressione del task, chiunque l'abbia introdotta. `complete_task` deve rifiutare l'accettazione con regressioni rispetto alla baseline del task.

**B2 — La calibrazione vede solo l'ultima delega di ogni task**

Riferimento: `learning.ts:187`.

Per non contare più volte deleghe correlate, `tuneEfforts` tiene un solo esito per task, ma è l'**ultimo** (una `Map` sovrascritta). Un task la cui prima delega è fallita e la seconda è passata conta come successo pieno. Nella direzione della qualità, l'effort non sale mai per un modello che sbaglia sempre al primo colpo, se il supervisore poi rimedia. Nella direzione del risparmio, la discesa di effort richiede "20 successi consecutivi al primo colpo", ma il primo colpo non viene davvero verificato.

Riprodotto (B2): sei task, ognuno con una delega fallita seguita da una riuscita, non producono alcun aumento di effort.

Correzione: il campione di un task è la sua qualità **peggiore**, o in alternativa quella della prima delega. Per la discesa di effort servono task in cui **tutte** le deleghe sono passate al primo colpo, come fa già `routeWithEvidence` in `routing.ts`.

**B3 — Raggiunto il limite di turni, la sessione del worker viene buttata**

Riferimenti: `index.ts:409`, `index.ts:918`, `index.ts:1745`, `index.ts:2290`, `config.json:273`.

A10 ha introdotto `--max-turns` per profilo: small 30, medium 60, large 100, critical 120, e per i revisori un valore fisso di 30. In Claude Code un turno è un'iterazione dell'agente: ogni lettura, modifica o comando conta. Un task medio che legge alcuni file, modifica e riesegue i test può avvicinarsi a 60.

Quando il limite scatta:
- `executeImplementation` lancia un'eccezione;
- `performDelegation` non salva `workerSession` (era già stata azzerata a inizio delega);
- nessun esito viene registrato per l'apprendimento.

Il supervisore non può quindi continuare la sessione, che conosce già il codice. Deve delegare da capo, e un nuovo worker rifà l'esplorazione (obiettivo 4). Un modello che sbatte spesso contro il limite non vede mai alzare il proprio effort (obiettivo 2).

Riprodotto (B3): dopo `error_max_turns`, `continuePrevious` fallisce con *"no compatible previous worker session"* e non esiste alcun esito di apprendimento.

Correzione: salvare `workerSession` prima di interrompere, e restituire un risultato strutturato ("limite raggiunto, lavoro parziale conservato, riprendibile con continuePrevious") invece di un'eccezione. Registrare l'esito come segnale di difficoltà. Tarare i limiti su misure reali, oppure riprendere una volta in automatico la sessione con "continua" prima di fermarsi.

**B4 — La scadenza di 120 minuti è più corta dei timeout che contiene**

Riferimenti: `index.ts:2249`, `index.ts:1744`, `config.json:279`.

`delegationTimeoutMinutes` (120) copre baseline, implementazione, correzioni e review. Presi singolarmente, i limiti configurati sono:
- worker: 90 minuti;
- correzioni: 2 giri, fino a 90 minuti ciascuno;
- verifiche: 20 minuti per comando, fino a 4 comandi, eseguiti prima e dopo;
- review: 20 minuti.

Un task large o critical che usa davvero il tempo del worker non arriva mai a correzione e review. Alla scadenza il controller interrompe il processo e la delega esce con *"Operation aborted"*, lo stesso messaggio di un'interruzione dell'utente: la sessione è persa come in B3.

Riprodotto (B4) con una scadenza breve e un worker lento.

Correzione: scadenza per profilo e coerente con i limiti interni, oppure calcolata da quelli. Alla scadenza, fermare il lavoro in modo pulito tra una fase e l'altra, non a metà processo, conservando la sessione. Messaggio distinto dall'abort dell'utente.

**B5 — Un revisore che fallisce per un motivo "task" chiude la catena**

Riferimenti: `index.ts:1835`, `index.ts:918`.

In `runConsultation` il ciclo si ferma su qualunque errore che non sia di provider (`kind === "task"`). Per l'implementazione è giusto: non si cambia modello per nascondere un errore di codice. Per una review invece significa restare **senza review**: il revisore successivo non viene provato. Il caso più probabile è il limite di 30 turni di un revisore Claude su un diff grande (`error_max_turns`).

Riprodotto (B5): il revisore Sonnet raggiunge il limite, Gemini (pronto con `VERDICT: PASS`) non viene mai chiamato, e il risultato è *"INDEPENDENT REVIEW UNAVAILABLE"*.

Correzione: nelle consultazioni, qualsiasi fallimento o review incompleta passa al revisore successivo. Solo un'interruzione dell'utente ferma la catena. Limite di turni dei revisori proporzionato al diff o al profilo.

**B6 — I cambi di modello del supervisore bruciano la cache del prompt**

Riferimenti: `index.ts:1912`, `index.ts:2206`, `index.ts:2649`, `config.json:258`.

Il supervisore riceve tutta la conversazione a ogni turno, e il suo costo dipende soprattutto dalla cache del prompt, che è per modello. Ogni cambio di modello rilegge il contesto intero senza cache. Due percorsi di default producono cambi ripetuti.

- **`supervisorProfiles.small`** (gpt-6-sol). L'esplorazione avviene con il supervisore generale. Alla delega small il modello passa a gpt-6-sol, e `complete_task` riporta subito a gpt-5.5 per la risposta finale. Risultato: due letture complete senza cache per uno o due turni "economici". Riprodotto (B6): un task small produce esattamente due cambi di supervisore.
- **Task critical su più prompt.** A ogni nuovo prompt l'autorizzazione al modello di punta viene tolta e il supervisore torna al modello normale. Alla delega con `continuePrevious` torna il modello di punta, con la risposta già memorizzata. Sono due cambi per prompt, e il primo turno di un task critical, quello in cui si rilegge lo stato, gira con effort `default`. Ricavato dal codice.

Correzione: togliere `supervisorProfiles.small` dalla configurazione di default finché un confronto end-to-end non ne dimostra il vantaggio (il primo audit lo segnalava già, punto 9). Mantenere modello di punta ed effort del task aperto finché il task non viene chiuso o messo in pausa con `complete_task`: ora esiste una chiusura esplicita, quindi l'azzeramento a ogni prompt introdotto per A1 non serve più e costa.

**B7 — Nessuna review complessiva del task; l'accettazione guarda solo l'ultima delega**

Riferimenti: `index.ts:2381-2394`, `index.ts:2191-2193`, `index.ts:1797`.

Dopo A11 ogni review vede solo il delta della propria delega. Il primo audit raccomandava di conservare anche una review del task nel suo insieme quando le deleghe sono più di una ("Non sostituire la review finale con soli delta isolati"), ma non è stata aggiunta. Una correzione piccola viene quindi rivista senza il contesto delle modifiche precedenti.

Inoltre `complete_task` legge profilo, verdetto e verifica dell'**ultimo** `TaskPacket`, che viene ricostruito a ogni delega. Un task large che ha preso MAJOR e poi è stato "corretto" con una delega passata come medium si accetta senza alcuna review della correzione. Il prompt della review dice ancora *"diff against HEAD"*, mentre ora il diff è della sola delega.

Correzione: per i profili con review, prima di accettare un task con più deleghe, una review sul diff cumulativo del task (dal checkpoint della prima delega). Conservare nel task il profilo più alto e l'ultimo verdetto rilevante. Correggere l'etichetta del diff.

**B8 — Dopo un failover in correzione, l'esito va al modello sbagliato**

Riferimento: `index.ts:1675`.

Se Sonnet introduce una regressione ed esaurisce i crediti durante la correzione, Opus completa la riparazione. L'esito registrato è uno solo: modello Opus, verifica `fixed` (qualità 0,5). Opus viene penalizzato per un errore di Sonnet, e Sonnet non riceve alcun segnale.

Riprodotto (B8): un solo esito, `claude-opus-5-5 / fixed`.

Correzione: attribuire l'esito al primo implementatore (`fixed` o `failed`) e registrare il modello subentrato come esito separato di correzione, oppure escluderlo dalla calibrazione.

**B9 — Le evidenze di calibrazione sono frammentate**

Riferimenti: `learning.ts:161`, `learning.ts:182-185`.

La chiave di calibrazione è repository × tipo di task (11 valori) × profilo × modello, con finestra di 90 giorni. L'aumento di effort richiede 4 task distinti nello stesso gruppo, la discesa 20. In un repository con lavoro vario i gruppi restano quasi sempre sotto soglia, e gli aumenti, che proteggono la qualità, scattano di rado.

Correzione: separare le due direzioni. Aumento su un ambito largo (repository × profilo × modello, con qualsiasi tipo), perché un modello che sbaglia va rinforzato subito. Discesa sull'ambito stretto attuale, perché risparmiare richiede prove specifiche.

**B10 — Ordine dei revisori: il modello dell'implementatore prima dell'altra famiglia**

Riferimento: `index.ts:1864-1869`.

Per i task large l'ordine è: altri modelli Claude, poi lo stesso modello dell'implementatore, poi Gemini (API e CLI). Se l'altro modello Claude non è disponibile, Opus rivede il proprio lavoro prima che si provi Gemini.

Riprodotto (B10). La sessione è nuova e in sola lettura, quindi il danno è limitato, ma l'indipendenza è minore di quella offerta dall'altra famiglia.

Correzione: il modello dell'implementatore sempre in fondo, dopo Gemini.

**B11 — `run_verification` può riaprire un task accettato**

Riferimento: `index.ts:2470`.

Qualsiasi fallimento marca il task come `failed`: anche un task già `completed`, e anche un comando che falliva già prima. Un task accettato torna tra quelli "non finiti", e il recovery senza supervisore potrebbe rieseguirlo.

Riprodotto (B11).

Correzione: aggiornare solo un task aperto, e solo se il comando non era già rosso nella baseline del task (vedi B1).

**B12 — `minutes()` usato per i cooldown**

Riferimenti: `index.ts:1432`, `index.ts:1965`.

`minutes()` tiene conto della scadenza della delega. Usato per il cooldown dei modelli non disponibili (24 h), durante una delega lo tronca alla scadenza residua, al massimo 120 minuti, e lancia un'eccezione se il budget è già finito. Il modello inesistente viene così riprovato molto prima del previsto.

Riprodotto (B12): blocco ≤ 121 minuti invece di 1440.

Correzione: calcolare i cooldown con una conversione semplice minuti → millisecondi, fuori dal budget.

**B13 — Rifiniture**

- `parseVerdict` accetta il verdetto solo sull'ultima riga. Una frase di congedo del revisore dopo il verdetto fa partire un altro revisore: più token, nessun rischio di qualità.
- `markLessonsUsed` non viene mai chiamata: `uses` cresce solo con i duplicati, e ordinamento ed eliminazione delle lezioni si basano su quel valore.
- `data/usage.jsonl` cresce senza limite: serve una rotazione o un limite di righe.
- `unknownUsageRuns` conta anche i tentativi mai partiti (API non disponibile), gonfiando l'avviso di "usage unavailable".
- Il recovery senza supervisore non passa più al worker il testo della richiesta dell'utente che il supervisore non ha completato.
- Resta aperto il punto 4 del primo audit: selezione delle lezioni per pertinenza e regole lette lungo il percorso dei file modificati.

**Cosa funziona e va conservato**

Diff della singola delega con checkpoint dei contenuti (anche file non tracciati). Failover anche durante le correzioni. Ripresa della sessione dopo un errore transitorio, e resume Gemini compatibile con la CLI installata. Disponibilità ricontrollata prima di ogni candidato. Sonde limitate nel tempo e contabilizzate. Stato `unchanged_failures` distinto dal successo. Chiusura esplicita del task con `complete_task`. Lock tra processi sul file di apprendimento. Validazione della configurazione. Ordine dei worker basato su evidenze: prudente e trasparente (`Routing: …`).

**Ordine di intervento consigliato**

| Passo | Lavoro | Criterio di accettazione |
|---|---|---|
| 1 | B1: baseline per task e regola di accettazione | Una regressione del task non si può accettare, qualunque delega l'abbia introdotta |
| 2 | B3, B4: limiti che conservano la sessione ed esito strutturato; scadenza coerente | Un limite raggiunto è riprendibile con `continuePrevious` senza rifare l'esplorazione |
| 3 | B2, B8, B9: campione peggiore per task, attribuzione corretta, aumento su ambito largo | Riproduzioni B2 e B8 invertite; aumento di effort con 4 task qualsiasi del profilo |
| 4 | B5, B7, B10: catena di review robusta, review complessiva del task, ordine dei revisori | Nessun task large/critical accettato senza review del suo diff complessivo |
| 5 | B6: niente cambi di supervisore dentro un task | Nessun cambio di modello tra delega e `complete_task` per lo stesso task |
| 6 | B11, B12, B13 | — |

**Limiti dell'audit**

Le riproduzioni usano CLI simulate e un host Pi simulato: dimostrano il flusso di controllo dell'estensione, non il comportamento dei modelli. I limiti di turni e i tempi realistici di un task (B3, B4) vanno misurati su lavoro reale: l'audit mostra che il meccanismo perde la sessione, non quanto spesso il limite scatti. Il costo di B6 dipende dalle tariffe e dalla cache dei provider e non è stato misurato.
