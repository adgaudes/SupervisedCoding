**Audit SupervisedCoding — 24 settembre 2026**

Revisione analizzata: `e63e03a` (`README: status description`). Letti integralmente README, configurazione e i tre moduli dell'estensione; esaminati test e CLI simulate. Verificata parte dell'integrazione contro Pi 0.87.1 e il conteggio token contro il bundle locale di Gemini CLI 0.61.0. Nessuna chiamata a modelli reali durante i test. Codice operativo e configurazione lasciati invariati.

**Giudizio**

L'architettura rispetta un obiettivo sensato: qualità prima del costo, supervisore che decide e accetta, worker che implementano, verifiche deterministiche e continuità quando finiscono i crediti. Il margine di risparmio più sicuro consiste nel correggere lavoro ripetuto, stato obsoleto e misurazioni imprecise. Abbassare indiscriminatamente modelli o effort sarebbe prematuro: alcuni segnali usati per la calibrazione sono oggi errati.

Punti positivi da conservare: guida strutturata, strumenti del supervisore limitati, sessioni Claude riutilizzabili, correzioni nello stesso contesto, separazione degli errori di coding da quelli del provider, controlli Git prima/dopo, review indipendente sui profili maggiori, limiti ai giri di correzione e distinzione fra costo API equivalente e abbonamenti.

**Verifiche eseguite**

| Verifica | Risultato |
|---|---|
| `node --test tests/lib.test.ts tests/learning.test.ts` | 22 test passati |
| `node --import ./tests/resolve-pi.mjs --test tests/integration.test.ts` | 12 test d'integrazione passati |
| Riproduzioni aggiuntive in `audit/reproduce.test.ts` | 9 casi confermati con host Pi e CLI simulate |

I nove test di audit **asseriscono il comportamento difettoso attuale**: il loro successo conferma la riproduzione, non la correttezza dell'estensione. Vanno trasformati in test delle condizioni desiderate quando si implementano le correzioni. Esecuzione:

```powershell
node --import ./tests/resolve-pi.mjs --test audit/reproduce.test.ts
```

La suite originaria copre diversi percorsi nominali, ma in un caso codifica proprio il problema: il test sul fallimento preesistente richiede `verification === "passed"` anche quando il comando continua a fallire.

**Priorità**

P1 = correggere prima di fidarsi dell'ottimizzazione automatica o delle garanzie sui consumi. P2 = miglioramento significativo, successivo ai difetti P1. Le priorità considerano anche la qualità, come richiesto dal README.

| ID | Priorità | Riscontro | Impatto |
|---|---|---|---|
| A1 | P1 | Task non chiusi senza commit | Effort elevato e autorizzazioni flagship possono sopravvivere al task |
| A2 | P1 | Sonde su flagship non autorizzati e senza contabilità completa | Consumo iniziale evitabile e invisibile |
| A3 | P1 | Baseline fallita registrata come successo | Calibrazione e statistiche troppo ottimistiche |
| A4 | P1 | Calibrazione riusa evidenze antecedenti al cambio | Oscillazione dell'effort senza nuovi risultati |
| A5 | P1 | Nessun failover durante le auto-correzioni | Interruzioni e segnale di qualità contaminato |
| A6 | P1 | Review API senza garanzia di copertura completa | Risparmio ottenibile a scapito della qualità |
| A7 | P2 | Retry senza ripresa della nuova sessione | Ripetizione di contesto, esplorazione e lavoro |
| A8 | P2 | Coda dei candidati calcolata una sola volta | Tentativi contro account appena dichiarati esauriti |
| A9 | P2 | Sessioni Gemini non riutilizzate | Ripetizione di prompt, diff e letture |
| A10 | P2 | Limiti di output applicati solo dopo la generazione | Nessun tetto economico effettivo per delega |
| A11 | P2 | Diff cumulativi contro HEAD | Review ripetute e attribuzione imprecisa delle modifiche |
| A12 | P2 | Metriche non sufficientemente attribuite | Impossibile dimostrare risparmi affidabili per modello |

**A1 — Il ciclo di vita del task non termina con l'accettazione del supervisore**

Riferimenti: `index.ts:1246` (`openTask`), `index.ts:1777` (`flagshipGranted`), `index.ts:2338` (`request_git_commit`), `index.ts:2435` e `index.ts:2505` (eventi).

L'unica assegnazione di `phase: "completed"` avviene dopo un commit autorizzato. Un task terminato normalmente resta `implemented`; `agent_settled` gestisce il recovery, ma non chiude il task. Al prompt seguente, prima che il modello possa classificare il nuovo lavoro, `ensureBestSupervisor` e `applySupervisorEffort` usano ancora il vecchio task aperto.

Riprodotto: dopo una delega critical riuscita e un evento di completamento, il nuovo prompt parte ancora con effort `xhigh`. Una seconda riproduzione conferma che un supervisore marcato come flagship e approvato per il task precedente resta selezionato per una domanda successiva indipendente, senza nuova conferma.

Correzione: rendere espliciti accettazione, completamento e prosecuzione del task, indipendentemente da Git commit. Revocare il grant e ripristinare l'effort di default al completamento. Non chiudere indiscriminatamente a ogni fine turno: un turno può terminare con una domanda o con lavoro incompleto. La transizione deve registrare l'accettazione del supervisore o una decisione esplicita di prosecuzione.

**A2 — Il controllo crediti interroga anche i modelli di punta senza approvazione**

Riferimenti: `index.ts:1838`, `index.ts:1886`, `index.ts:1953`, `config.json:2`.

`refreshCredits` chiama Haiku e poi **tutti** i supervisori risolti e autenticati, senza filtro flagship, senza TTL e senza saltare i blocchi ancora validi. Con tutti i modelli della configurazione disponibili, sono sette chiamate per refresh: una Claude e sei Pi, inclusa Astra. La ripetizione di `/on` può ripetere le sonde. Non tutte le sonde restituiscono informazioni quantitative sul saldo: un semplice OK prova soprattutto la disponibilità corrente.

Riprodotto con un modello fittiziamente marcato come flagship: una chiamata `complete`, zero domande di approvazione. Inoltre `probeSupervisor` non registra `message.usage` in `recordRun`; le chiamate non sono normali turni della conversazione e sfuggono anche alla scansione degli assistant message effettuata da `usageReport`.

Correzione: sonde solo se la lettura è assente/scaduta, modello economico non flagship per ambiti di quota realmente condivisi, controlli distinti quando le quote sono per modello. Registrare tutte le sonde, impostare limiti di output appropriati al provider, differenziare refresh ordinario e forzato. Una sonda non deve aggirare la politica di autorizzazione del README.

Il risparmio qui è misurabile in chiamate eliminate; l'importo dipende dall'autenticazione e dalle tariffe o quote effettive.

**A3 — “Nessuna nuova regressione rilevata” viene trasformato in “test passati”**

Riferimenti: `index.ts:2146`, `index.ts:2163`, `index.ts:2180`, `index.ts:2212`, `learning.ts:87`.

La baseline conserva solo un booleano per comando. I comandi già falliti vengono esclusi da `regressions`; se non restano regressioni, `verification` diventa `passed`, anche quando nessun comando è verde. Tale risultato alimenta `firstPassDelegations` e la serie dei venti successi richiesta per abbassare l'effort.

Riprodotto: comando fallito prima e dopo, testo del report che ammette il fallimento preesistente, ma record di apprendimento con `verification: "passed"`. Inoltre, se una suite aveva già un test rosso, ulteriori regressioni nella stessa suite non sono distinguibili dal solo exit code.

Correzione: distinguere `passed`, `unchanged_failures`, `regressed`, `unverified` e, se utile, copertura parziale. Non attribuire al worker i guasti preesistenti, ma non considerarli prove di successo. Quando disponibile, confrontare identità e risultati dei singoli test tramite report strutturati. Eseguire anche test mirati sulle parti modificate quando una suite globale è già rossa.

**A4 — L'isteresi della calibrazione non è implementata fino in fondo**

Riferimento: `learning.ts:130`.

Gli adjustment salvano `since`, ma i filtri sui risultati non lo usano. Vengono selezionati tutti i risultati storici al livello di effort corrente. Dopo una discesa a un livello già usato in passato, tornano valide le vecchie evidenze che lo avevano fatto salire.

Riproduzione: quattro fallimenti a `high` fanno salire a `xhigh`; venti successi a `xhigh` fanno scendere a `high`; due ulteriori chiamate di calibrazione, senza nuovi outcome, producono prima `xhigh` e poi nuovamente `high`. Questo contraddice la promessa di prove nuove dopo ogni cambio.

Correzione: associare i campioni a un'epoca di calibrazione, con cursore monotono o identificativo; usare solo esiti successivi all'ultimo cambio/configurazione. Un timestamp da solo richiede attenzione agli esiti con lo stesso millisecondo. Verificare anche il rientro verso un effort già visitato, non solo il primo aumento.

**A5 — Le auto-correzioni perdono il failover dei worker**

Riferimenti: `index.ts:1388`, `index.ts:2165`, `index.ts:1573`.

`runCorrection` ritenta gli errori transitori, ma per crediti, autenticazione o indisponibilità restituisce il problema al chiamante. Il ciclo esce e la delega fallisce: non viene consultata la catena dei candidati rimanenti.

Riprodotto: Sonnet introduce una regressione e finisce i crediti durante la correzione; Opus è disponibile e predisposto per correggere, ma non viene mai invocato. È necessario un nuovo turno del supervisore. Il record di apprendimento usa come `final` il risultato dell'implementazione iniziale, riuscito: il filtro che dovrebbe escludere guasti del provider non vede il guasto della correzione e registra comunque un fallimento qualitativo.

Correzione: un unico esecutore di tentativi per implementazione e correzione, con handoff del diff, diagnostica e stesso perimetro autorizzato. Separare `provider_failure` da `quality_failure` negli outcome. Il cambio di modello resta escluso per normali errori di coding, coerentemente con il README.

**A6 — La review API non garantisce gli stessi elementi di giudizio della CLI**

Riferimenti: `index.ts:672`, `index.ts:1030`, `index.ts:1062`, `index.ts:1683`, `index.ts:2201`.

`collectFiles` visita le directory fino a una profondità limitata e salta silenziosamente quelle più profonde. In quel caso restituisce comunque materiale valido, anziché segnalare la copertura incompleta. Il revisore API non ha tool per recuperare il resto. Separatamente, il diff viene troncato a `maxDiffBytes`, con una nota che invita a leggere altri file: invito attuabile dalla CLI ma non dall'API.

Riprodotto con allowlist `src`: una modifica in `src/a/b/c/deep.ts` arriva nel diff, ma il blocco FILES contiene `(none)`. Il caso dimostra l'assenza del contesto completo, non che ogni review di quel diff sia necessariamente sbagliata. Con diff troncato e percorsi profondi, anche parte delle modifiche può restare fuori dal materiale disponibile.

Il budget è inoltre fisso: fino a 250.000 byte di file interi, più 60.000 di diff e prompt. Su file grandi può duplicare molto materiale e inviare file non modificati solo perché appartengono alla directory autorizzata.

Correzione: costruire un manifest dei file realmente cambiati, copertura esplicita, segmenti di codice attorno agli hunk e dipendenze necessarie. Se mancano informazioni essenziali, usare una review CLI o più porzioni controllate. Non equiparare automaticamente API e CLI: l'equivalenza va valutata con lo stesso materiale e criteri di qualità.

**A7 — Retry transitori che ricominciano l'implementazione**

Riferimento: `index.ts:1624`.

Il `resumeId` è fissato prima del ciclo dei retry e proviene solo da una precedente delega. Se una nuova sessione Claude produce lavoro e poi un errore transitorio, il suo `result.sessionId` non diventa il resume del tentativo successivo. Il retry invia lo stesso prompt completo come nuova sessione. Nelle correzioni l'ID non viene aggiornato fra retry; quando già si riprende una sessione, resta almeno disponibile il contesto precedente.

Riprodotto: primo tentativo con modifica parziale e errore 503, secondo tentativo senza `--resume` e con prompt identico. Con `transientRetryAttempts: 4` si arriva a cinque avvii per candidato. Il costo reale dipende da quanto il tentativo fallito aveva già prodotto.

Correzione: conservare la sessione appena ottenuta, riprenderla con una richiesta breve di completamento, e usare un handoff aggiornato se non è recuperabile. Aggiungere deadline cumulativa, backoff con jitter e rispetto di eventuale Retry-After. Distinguere i retry interni della CLI da quelli dell'estensione prima di modificare i numeri.

**A8 — I candidati successivi non vengono ricontrollati dopo un nuovo blocco**

Riferimenti: `index.ts:1603`, `index.ts:1614`, `index.ts:1671`.

`rankCandidates` viene chiamata prima del ciclo. `recordWorkerHealth` può poi bloccare un intero account, ma i successivi candidati già presenti in `usable` vengono comunque eseguiti. Lo stesso schema compare nelle consultazioni.

Riprodotto: primo modello Claude segnala esaurimento dell'account, il secondo Claude viene comunque chiamato prima di Gemini. Si sprecano avvio e tentativo; una richiesta respinta può non essere fatturata, quindi non va equiparata automaticamente a token pagati.

Correzione: ricontrollare `availability` prima di ogni invocazione e ricalcolare l'ordine dopo gli aggiornamenti di salute. Preservare la distinzione tra quota del modello, famiglia e account.

**A9 — Gemini non beneficia del riuso di sessione**

Riferimenti: `index.ts:958`, `index.ts:1398`, `index.ts:2155`, `index.ts:2189`.

La CLI restituisce `session_id`, ma `WorkerSession` viene mantenuta solo per Claude e `runGemini` non passa `--resume`. Correzioni e nuovi passi Gemini ricevono nuovamente guida, regole e diff. La funzionalità di resume per ID è documentata dalla [CLI Gemini](https://geminicli.com/docs/cli/session-management/).

Correzione: generalizzare la sessione con provider, modello, task, perimetro e dimensione/età del contesto. Il riuso va misurato: riduce la ricostruzione del lavoro, ma riproporre una cronologia enorme può costare più di un nuovo handoff mirato. Non presumere che OAuth e API key abbiano la stessa cache; la [documentazione Gemini sulla cache](https://geminicli.com/docs/cli/token-caching/) distingue esplicitamente le modalità di autenticazione.

**A10 — Il limite di output non è un limite di spesa**

Riferimenti: `index.ts:812`, `index.ts:857`, `index.ts:1076`, `index.ts:1838`, `config.json`.

`maxOutputBytes` tronca il materiale restituito al supervisore quando il worker ha già generato la risposta. Riduce il contesto dei turni successivi, ma non il costo di quella generazione. I worker hanno timeout temporali, senza limite di turni o budget di delega. La review API e la sonda Pi non impostano `maxTokens`. La memoria di stdout/stderr cresce prima del troncamento; anche la raccolta di file e diff legge materiale prima di applicare alcuni limiti.

Correzione: budget per ruolo/profilo, soglie progressive di costo o turni e arresto senza scartare il lavoro. Per Claude esistono `--max-turns` e `--max-budget-usd`, documentati nella [CLI reference](https://code.claude.com/docs/en/cli-reference); quest'ultimo non equivale a un misuratore delle quote di abbonamento. La documentazione Gemini descrive anche `maxSessionTurns`. L'estensione deve mantenere un budget cumulativo oltre alle singole invocazioni/resume, senza trattare il proprio tetto come credito esaurito del provider e aggirarlo passando al modello successivo.

I limiti devono permettere di completare il reasoning e produrre un rapporto utile: non conviene ridurre alla cieca l'output delle review critiche. Se un output viene interrotto per lunghezza, non considerarlo una review completa.

**A11 — Review e handoff ricevono il diff cumulativo contro HEAD**

Riferimenti: `index.ts:672`, `index.ts:1657`, `index.ts:2200`, `index.ts:2221`.

Il diff è quello del working tree rispetto a HEAD, non quello della singola delega. Modifiche preesistenti e deleghe precedenti nello stesso file vengono riproposte e possono essere attribuite al worker corrente. Nei follow-up lunghi si rivede ripetutamente lavoro già verificato. Anche `Changed files` riporta tutti i file sporchi dello snapshot finale, non solo il delta della delega.

Correzione: checkpoint dei contenuti prima dell'intervento, diff della delega e distinzione esplicita dalle modifiche preesistenti. Conservare comunque una review aggregata del task quando serve a verificare interazioni fra più deleghe. Non sostituire la review finale con soli delta isolati.

Una cache della review deve includere contenuti, contesto, requisiti, verifiche, modello e configurazione del revisore; il solo hash del diff è insufficiente se cambiano dipendenze o criteri di accettazione.

**A12 — La contabilità è utile, ma non è ancora una misura esatta del risparmio**

Riferimenti: `index.ts:731`, `index.ts:1279`, `index.ts:1455`, `index.ts:1530`, `index.ts:1573`, `index.ts:1838`.

- Le sonde Pi non sono contabilizzate, come descritto in A2.
- `geminiUsage` somma i token di tutti i modelli presenti in `stats.models` e attribuisce l'intero totale al primo modello. Se Gemini usa più modelli, i consumi per modello e la stima economica sono inesatti. Non ho riscontrato un doppio conteggio dei token cached nella CLI installata: il suo campo `input` è già al netto della cache.
- Le metriche API usano come chiave `api:<model>` senza provider. Lo stesso identificatore su due provider confluisce nella stessa riga.
- L'autenticazione Gemini è dedotta dalle variabili di ambiente; la modalità effettiva può dipendere dalla configurazione CLI. Il billing del supervisore viene ricostruito con l'autenticazione corrente, non quella storica. Una riga worker conserva l'ultimo billing e lo applica al totale aggregato.
- La voce “Real spend” include importi stimati o con billing sconosciuto: va distinta da una spesa effettivamente accertata.
- Il delta delle finestre quota misura il cambiamento dell'account fra due letture. Può includere altri client; dopo un reset, la differenza negativa viene portata a zero. Non è attribuzione esatta alla conversazione.
- `runCorrection` registra in `metrics` ogni tentativo, ma restituisce solo l'ultima usage: il totale della delega e l'outcome di apprendimento possono omettere i retry delle correzioni.
- Abort o timeout senza evento finale possono lasciare consumi non disponibili; non vanno interpretati come consumo zero.
- `failedDelegations` non viene incrementato nel catch generale. Una review MAJOR non rende automaticamente `isError` vero: coerente con l'accettazione affidata al supervisore, ma “completed delegation” non significa “task accettato senza difetti”.

Correzione: registro append-only per invocazione con request/attempt/task ID, ruolo, provider, modello richiesto ed effettivo, effort, billing rilevato al momento della chiamata, usage distinta per modello, completezza della misura e risultato. Tenere separati costo API, equivalente API, quota osservata e dati sconosciuti. Baseline delle quote legata anche all'identità/reset della finestra.

**Altri miglioramenti emersi**

1. **Verifiche e snapshot Git.** `getGitSnapshot` avvia sette comandi Git sequenziali e calcola hash dei file sporchi; `runCheck` lo esegue prima e dopo ogni comando. La baseline viene rieseguita a ogni delega e il worker è a sua volta invitato a eseguire i test. Consolidare raccolte indipendenti e riusare una verifica solo a parità di contenuti, dipendenze, configurazione e ambiente rilevanti. Il beneficio principale è locale e di latenza; i test locali non consumano di per sé token. Non ridurre copertura per velocizzare.

2. **Apprendimento fra processi.** `saveLearning` effettua una sostituzione atomica del file, ma ogni istanza carica lo stato una sola volta: due sessioni Pi possono sovrascriversi outcomes e lezioni. Servono lock con rilettura/merge oppure un archivio transazionale. Distinguere i risultati per repository o introdurre una gerarchia globale/locale prima di tarare un modello sulla somma di progetti molto diversi. Gli outcome hanno già `repo`, ma la calibrazione è globale per profilo/modello.

3. **Disattivazione della calibrazione.** `learning.autoTuneEffort: false` impedisce nuovi adjustment, ma `executeImplementation` applica ancora quelli salvati se `learning.enabled` è true. Chiarire se il flag significa congelare o disattivare, ed esporre separatamente le due scelte.

4. **Lezioni e regole.** Le lezioni sono inserite tutte fino al limite di 15; una selezione per pertinenza ridurrebbe rumore. Le regole vengono lette solo da cwd e root Git, non dalla gerarchia dei percorsi modificati. Il limite di 12 KB può troncare istruzioni importanti. Segnalare omissioni e caricare le regole applicabili ai file interessati evita errori e giri di correzione.

5. **Recovery esterno.** `recoverFromSupervisorFailure` forza il profilo critical e lancia implementazione più review senza usare la stessa pipeline di baseline e auto-verifica della delega ordinaria. Non usa l'esito della review per aggiornare l'esito complessivo. Può quindi aumentare i costi e indebolire le garanzie proprio quando manca il supervisore. Riutilizzare la pipeline ordinaria e conservare il profilo originale salvo escalation motivata.

6. **Permessi e perimetro.** `allowedPaths` è soprattutto un vincolo di prompt con controllo Git successivo, non un recinto preventivo di filesystem. File ignorati e scritture esterne al repository non sono coperti dal normale snapshot. Il README dovrebbe chiamarlo controllo post-esecuzione. Su task ad alto rischio, isolamento e permessi effettivi evitano costosi recuperi. I comandi di verifica sono autorizzati per prefisso: non equivalgono a “nessuna mutazione”; una build può scrivere file e script di progetto possono avere effetti propri.

7. **Configurazione e manutenzione.** Validare anche numeri finiti, timeout, retry, effort, modelli e reviewer. Attualmente `reviewApi` non viene escluso se si configura un flagship, nonostante il README vieti flagship per review. Separare runner, routing, contabilità, verifiche e lifecycle ridurrebbe il rischio di divergenze come quella tra implementazione e correzione. Non serve una riscrittura completa.

8. **Istruzioni contraddittorie.** README e descrizione di `plan_task` lo richiedono per ogni task; la policy iniettata lo richiede solo per large/critical o più deleghe. Il secondo percorso risparmia un turno per lavori semplici, ma va reso coerente in tutte le istruzioni. `run_verification` contiene ancora una descrizione che invita alla verifica prima di accettare large/critical, mentre il risultato della delega vieta di ripetere quelle già eseguite: precisare “solo verifiche mancanti o invalidate”. Anche la riduzione manuale dell'effort è limitata a small nel codice, diversamente dalla formulazione generale del README.

9. **Modelli per profilo.** Il worker cambia per complessità, mentre il supervisore usa quasi sempre la stessa catena di preferenza globale. Un supervisore più economico per task small potrebbe aiutare, ma va provato dopo le correzioni del lifecycle. Cambiare modello spesso può aumentare i costi di ricostruzione del contesto/cache e peggiorare la qualità: servono sessioni stabili e misure end-to-end.

**Ordine di intervento consigliato**

| Passo | Lavoro | Criterio di accettazione |
|---|---|---|
| 1 | Lifecycle, grant flagship, sonde e contabilità delle chiamate | Un nuovo task non eredita costo/consenso; tutte le invocazioni sono visibili |
| 2 | Stati di verifica e calibrazione con evidenze nuove | Nessuna discesa su test rossi; nessun cambio senza campioni nuovi |
| 3 | Runner unico, resume retry, failover correzioni, health aggiornata | Nessun rifacimento evitabile; continuità sui guasti provider |
| 4 | Copertura review, delta di delega e budget | Risparmio di contesto senza omettere materiale essenziale |
| 5 | Resume Gemini, caching verifiche, routing sperimentale per profilo | Riduzione misurata del costo per task accettato, qualità invariata |

**Come misurare il risparmio senza confondere token e crediti**

Il repository non contiene una serie di benchmark o dati di apprendimento locali che permetta di attribuire una percentuale di risparmio. Il README dichiara un consumo tipico dell'1–3% della finestra Claude per task medio, ma non presenta misure che ne dimostrino la generalità. Neppure “review API con gli stessi risultati e una frazione dei token” è garantito dall'implementazione: contesto, autenticazione e modalità di review possono essere diversi.

Per una valutazione successiva, usare un insieme fisso di task small/medium/large/critical, stesso stato iniziale, criteri di accettazione verificabili e più ripetizioni per la variabilità dei modelli. Registrare:

- qualità: test realmente verdi, difetti materiali trovati dopo l'accettazione, correzioni e interventi del supervisore;
- consumo: input non cached, cache-read/write, output e reasoning secondo la semantica del provider, chiamate e tentativi per ruolo;
- economia: costo API totale per task accettato; quote d'abbonamento osservate separatamente e solo se attribuibili;
- efficienza: turni del supervisore, contesto reinviato, resume, fallimenti evitabili e verifiche duplicate.

Confrontare una modifica alla volta. La metrica principale deve essere **costo del task correttamente accettato**, non costo della singola chiamata: un modello più economico che richiede più correzioni può costare di più. Per abbonamenti a tariffa fissa, meno token non implica uno sconto economico lineare; il beneficio può essere maggiore capacità disponibile nella finestra.

**Limiti dell'audit**

Le riproduzioni dimostrano il controllo di flusso dell'estensione con CLI simulate e repository Git reali. Non misurano la qualità dei modelli, le tariffe correnti dei singoli piani né la risposta di tutti i provider a ogni evento reale. Non è stato effettuato un benchmark a pagamento. Le priorità e le modifiche proposte sono quindi fondate su difetti riprodotti e analisi del codice; le percentuali di risparmio restano da misurare.
