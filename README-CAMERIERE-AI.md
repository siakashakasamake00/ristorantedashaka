# Cameriere AI (Claude) · come metterlo online

Il cameriere virtuale ora **conversa davvero** usando l'API di Claude (modello `claude-haiku-5-5`).
La vecchia modalità **a parole chiave** resta come riserva e parte **da sola** se:

- l'AI è spenta (`"ai": false`) o manca la chiave API;
- l'API di Anthropic non risponde, va in errore o supera i tempi;
- il cliente supera i **20 messaggi** nella stessa sessione;
- dallo stesso indirizzo IP arrivano troppi messaggi (predefinito **120 ogni 10 minuti**: è alto apposta, perché i clienti sul Wi-Fi del locale escono tutti con lo stesso IP);
- la spesa stimata del mese raggiunge il **tetto** (predefinito **20 €**).

Il cliente non vede errori: legge la riga "Ti rispondo in modo più semplice, con i dati del menu" e il menu continua a funzionare.

---

## 1. File da caricare su GitHub

Carica questi file **al loro posto** nel repository (GitHub → apri la cartella → *Add file → Upload files*; un file con lo stesso nome viene sostituito):

| File | Nuovo / modificato | A cosa serve |
|---|---|---|
| `netlify/functions/chat.js` | **nuovo** | la conversazione con Claude, i limiti e la riserva automatica |
| `netlify/lib/chat-core.mjs` | **nuovo** | istruzioni del cameriere costruite dal menu, ricalcolo dei totali, controllo prenotazioni, costi |
| `netlify/lib/cliente-ai.mjs` | **nuovo** (generato da `build.py`) | nome e carattere del cameriere, acceso/spento, limiti e tetto di spesa |
| `netlify/functions/admin.mjs` | modificato | nuova voce per il pannello: conversazioni e costo del mese |
| `netlify/functions/marina.mjs` | modificato | il vecchio indirizzo ora è chiuso (i telefoni con la pagina vecchia passano alle parole chiave, senza costi) |
| `index.html` | modificato | la chat usa `/api/chat`, mostra ordini e prenotazioni proposti dall'AI |
| `admin.html` | modificato | in **Statistiche**: conversazioni e costo stimato del mese |
| `package.json` | modificato | aggiunge la libreria ufficiale `@anthropic-ai/sdk` e il comando `npm test` |
| `sorgenti/build.py` | modificato | legge `"ai": true/false` e scrive `netlify/lib/cliente-ai.mjs` |
| `sorgenti/cliente.json` | modificato | `"ai": true` + blocco `ai_impostazioni` |
| `sorgenti/nuovo-cliente/cliente.json` | modificato | esempio con `"ai": false` |
| `sorgenti/menu.template.html`, `sorgenti/admin.template.html` | modificati | le stesse modifiche di `index.html` e `admin.html`, per i siti generati |
| `test/test-cameriere-ai.mjs` | **nuovo** | test locale con API simulata |

## 2. La chiave API su Netlify (obbligatoria)

1. Crea la chiave su **console.anthropic.com → API Keys → Create Key** (copiala subito: non viene più mostrata).
2. Netlify → il progetto → **Project configuration → Environment variables → Add a variable**:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** la chiave (`sk-ant-...`)
   - spunta **Contains secret values**; negli *Scopes* lascia almeno **Functions**.
3. **Deploys → Trigger deploy → Deploy project** (le variabili valgono solo dal deploy successivo).

La chiave sta **solo** su Netlify: non va mai scritta nei file del sito, e il telefono del cliente non la vede mai (parla solo con `/api/chat`).

Facoltativa: `CHAT_MODEL` sostituisce il modello scritto nella scheda cliente (di solito non serve).

**Consigliato:** imposta anche un limite di spesa mensile nella Console Anthropic (nella sezione dei limiti dell'organizzazione). È una seconda rete di sicurezza, oltre al tetto del sito.

## 3. Verifica dopo il deploy

1. Apri il menu dal telefono, tocca il cameriere, scrivi "Cosa mi consigli stasera?": deve rispondere in modo naturale, con le schede dei piatti.
2. Scrivi "Mettimi due [piatto]": compare "Aggiunto al carrello" con il **totale calcolato dal menu**.
3. Pannello titolare → **Statistiche**: in alto il riquadro *Cameriere AI* con conversazioni e costo stimato del mese.
   Se c'è scritto "chiave API mancante", la variabile non è stata salvata o manca il nuovo deploy.

## 4. Accendere, spegnere, cambiare i limiti

Nella scheda `sorgenti/cliente.json`:

```json
"ai": true,
"ai_impostazioni": {
  "modello": "claude-haiku-5-5",
  "max_tokens": 600,
  "max_messaggi_sessione": 20,
  "max_messaggi_ip": 120,
  "finestra_ip_minuti": 10,
  "tetto_mensile_eur": 20,
  "cambio_usd_eur": 0.92,
  "prezzi_usd_mtok": { "input": 0.10, "output": 0.50, "cache_write": 0.125, "cache_read": 0.01 }
}
```

Poi `python3 sorgenti/build.py` rigenera le pagine e `netlify/lib/cliente-ai.mjs` (con `"ai": false` il menu nasce già in modalità parole chiave e il server non chiama mai l'API).

> **Attenzione per Da Shaka:** nel repository i modelli `sorgenti/*.template.html` sono **più vecchi** di `index.html` e `admin.html` pubblicati (mancano recensioni, mappa, statistiche visite, prenotazioni nel pannello), e la cartella `foto/` non c'è. Rigenerare da lì farebbe perdere quelle funzioni e le foto. Finché i modelli non sono allineati, per Da Shaka **non rilanciare `build.py`**: per spegnere l'AI o cambiare il tetto basta modificare i valori dentro `netlify/lib/cliente-ai.mjs` (stessi nomi) e caricarlo. Con `"ai": false` il server risponde sempre "usa le parole chiave" e il costo è zero.

## 5. Come funziona (in breve)

- **Unica fonte dei dati:** a ogni messaggio le istruzioni del cameriere vengono costruite dal menu salvato in Netlify Blobs (lo stesso che usa la cassa: prezzi, esauriti, allergeni, orari, indirizzo) e dalla scheda cliente (nome, ruolo, carattere). Un prezzo cambiato nel pannello vale dal messaggio successivo. Finché il titolare non salva nulla dal pannello, si usa il menu di partenza di `index.html`, come per gli ordini.
- **Niente piatti o prezzi inventati:** l'AI deve citare i piatti col codice (es. `[P01]`) e la chat mostra nome e prezzo **presi dal menu**. Se l'AI scrive comunque un prezzo sbagliato accanto a un codice, il server lo corregge; i codici inesistenti spariscono.
- **Allergeni:** l'AI riporta quelli del menu e ricorda sempre di confermare con il personale; non dice mai "sicuro al 100%".
- **Ordini:** l'AI produce un blocco strutturato (solo codici, quantità e note). Il server **ricalcola righe e totale dai prezzi del menu**, scarta piatti inesistenti o esauriti e il cliente vede il totale ricalcolato. Il carrello poi viene inviato come sempre a `/api/ordini`, che ricalcola di nuovo.
- **Prenotazioni:** blocco strutturato (giorno, ora, persone, nome, telefono, note) controllato dal server (date passate, giorni di chiusura, telefono). Parte solo quando il cliente tocca **Invia richiesta** e arriva nel pannello come le altre (stato "nuova").
- **Costi:** `max_tokens` limitato, ragionamento al minimo (`effort: low`), parte fissa delle istruzioni in cache (costa un decimo nei messaggi successivi). Il costo di ogni risposta viene calcolato dai token reali restituiti dall'API e sommato nel mese (`ai/uso/AAAA-MM` in Netlify Blobs).
- **Privacy:** per il limite per IP si salva solo un'impronta dell'indirizzo, non l'indirizzo.

Ordine di grandezza (stima, prezzi di ottobre 2026): le istruzioni sono circa 5.000 token; un messaggio costa più o meno **0,02–0,08 centesimi** (di più il primo di ogni sessione, quando la cache si riempie). Il costo reale dipende dalla lunghezza delle conversazioni: guarda il riquadro nel pannello dopo qualche serata.

## 6. Test locale (facoltativo, serve Node 22)

Dalla cartella del sito:

```bash
npm install
npm test
```

Il test non usa la chiave vera né Netlify: avvia un archivio Netlify Blobs locale e un'API Anthropic simulata, e usa le funzioni vere. Controlla:

1. il prompt nasce dal menu salvato: **prezzo cambiato nel pannello** e piatto esaurito arrivano subito al cameriere (e nessun piatto è scritto a mano);
2. **ricalcolo dei totali**: prezzi e totale scritti dall'AI vengono ignorati, piatti inesistenti/esauriti scartati, prezzo sbagliato nel testo corretto;
3. prenotazione in un giorno di chiusura rifiutata;
4. **riserva automatica quando l'API è giù** (errore 529 e connessione caduta);
5. **limite di 20 messaggi** per sessione (il 21° non chiama l'API);
6. limite per IP;
7. pannello: conversazioni e costo del mese, poi **tetto superato → parole chiave** senza chiamare l'API.

## Limiti da sapere

- Il costo nel pannello è una **stima** dai prezzi scritti nella scheda: se Anthropic cambia i prezzi, aggiorna `prezzi_usd_mtok`. Fa fede la fattura Anthropic.
- Il tetto viene controllato prima di ogni messaggio: con molti messaggi nello stesso istante si può superare di pochi centesimi.
- Netlify ferma una funzione dopo 10 secondi: per questo la chiamata all'API ha un tempo massimo di 8 secondi, poi parte la riserva.
