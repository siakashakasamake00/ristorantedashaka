# Da Shaka · Menu, Marina, ordini al tavolo e pannello del titolare (solo Netlify)

Sistema completo **senza database esterno**: tutto gira su Netlify (pagine + funzioni + Netlify Blobs).

| Indirizzo | Chi lo usa | Cosa fa |
|---|---|---|
| `/?tavolo=7` | cliente (dal QR) | menu con foto, allergeni, filtri, carrello, **Marina**, invio ordine, stato in tempo reale |
| `/cucina.html` | cucina (tablet/PC, **PIN cucina**) | ordini nuovi con avviso e suono, Prendi in carico → Pronto → Servito |
| `/admin.html` | titolare (**PIN titolare**) | prezzi, piatti esauriti, nuovi piatti con foto, statistiche, storico ordini e CSV, dati del locale |
| `/tavoli.html` | titolare | QR Code di tutti i tavoli, cartoncino PNG, stampa |

> Ristorante e dati **di fantasia** per demo. Allergeni **dimostrativi**, non una certificazione. Foto **generate con AI**.

## File

```
index.html                       menu clienti (dati, 93 foto e codice incorporati)
cucina.html                      dashboard cucina
admin.html                       pannello del titolare
tavoli.html                      QR Code tavoli
netlify/functions/ordini.mjs     salva e aggiorna gli ordini
netlify/functions/marina.mjs     la cameriera virtuale (Claude)
netlify/functions/menu-api.mjs   legge e salva il menu modificato dal pannello
netlify/functions/foto.mjs       foto dei piatti caricate dal pannello
netlify/functions/admin.mjs      statistiche e storico ordini
netlify/lib/menu.mjs             funzioni condivise
netlify.toml, package.json       configurazione Netlify
foto/, sorgenti/                 foto originali e file per rigenerare il sito (anche per altri clienti)
```

## Variabili su Netlify (Project configuration → Environment variables)

| Variabile | Valore | Serve per |
|---|---|---|
| `KITCHEN_PIN` | PIN scelto da te (solo cifre) | entrare nella dashboard cucina |
| `ADMIN_PIN` | PIN **diverso**, meglio 8 cifre | entrare nel pannello del titolare |
| `ANTHROPIC_API_KEY` | chiave da console.anthropic.com (spunta *Contains secret values*) | far parlare Marina |
| `CHAT_MODEL` | facoltativa, predefinito `claude-haiku-4-5` | modello di Marina |

Non scrivere mai i PIN nei file del sito: Netlify blocca la pubblicazione se li trova. Dopo aver aggiunto o cambiato una variabile: **Deploys → Trigger deploy → Deploy project**.

## Pannello del titolare (`/admin.html`)

- **Menu:** cambi il prezzo direttamente nella riga, l'interruttore verde/grigio segna *Esaurito*, ✏️ apre la scheda del piatto (nome, descrizione, categoria, allergeni, vegetariano, foto dal telefono). **+ Nuovo piatto** aggiunge un piatto. Si salva da solo ("Salvato ✓").
- **Statistiche:** oggi, ieri, 7 o 30 giorni o date a scelta: incasso, ordini, scontrino medio, piatti venduti, tempo medio di preparazione, orari di punta, piatti più venduti, incasso per categoria e per tavolo.
- **Ordini:** elenco con filtri per stato e tavolo, **Scarica CSV** che si apre in Excel.
- **Locale:** nome, indirizzo, orari, servizi, informazioni, numero di tavoli (i QR si aggiornano), sigla degli ordini, categorie.

Le modifiche arrivano ai clienti entro un minuto, anche a chi ha già il menu aperto. I prezzi degli ordini vengono sempre ricalcolati dal menu salvato e i piatti esauriti non si possono ordinare. Se modifichi da due dispositivi insieme, il secondo riceve l'avviso di ricaricare e niente viene sovrascritto per errore.

## Messa online (prima volta)

1. **GitHub** → New repository → *uploading an existing file* → trascina il **contenuto** della cartella → Commit.
2. **Netlify** → Add new project → Import an existing project → GitHub → scegli il repository → Deploy.
3. Aggiungi le variabili della tabella sopra, poi **Trigger deploy**.
4. Apri `/tavoli.html` **dal sito Netlify** e stampa i QR.

Netlify Drop (trascinare la cartella) **non** va bene: le funzioni non verrebbero pubblicate.

## Un nuovo cliente (altro ristorante)

Lo stesso sistema funziona per qualsiasi locale: cambiano menu, foto, colori e cameriere.

**La via più semplice:** manda a Claude il menu (foto del menu cartaceo, PDF o testo), il nome e l'indirizzo del locale, i colori o il logo, il nome e il carattere del cameriere virtuale e, se ci sono, le foto dei piatti. Ti restituisce la cartella pronta da caricare su un nuovo repository GitHub e un nuovo progetto Netlify.

**Da soli (serve Python con `pip install pillow`):**

1. Copia `sorgenti/nuovo-cliente/` (esempio: *Trattoria Esempio* con il cameriere *Giulio*).
2. In `menu.json` scrivi locale e piatti (nome, descrizione, prezzo, allergeni, vegetariano). Metti `"demo": false` per un locale vero.
3. In `cliente.json` scegli il nome del cameriere, il suo carattere, il saluto, i suggerimenti e i colori (`principale` = intestazione scura, `accento` = pulsanti).
4. Le foto vanno nella cartella indicata in `cartella_foto`, con il nome del piatto (es. `tortelli-con-la-coda.jpg`). Senza foto il piatto mostra un'immagine neutra, e la si può aggiungere dopo dal pannello.
5. Dalla cartella `sorgenti`: `OUT=../../sito-nuovo-cliente python3 build.py nuovo-cliente/cliente.json`
6. La cartella `sito-nuovo-cliente` contiene tutto (pagine, funzioni, configurazione): nuovo repository GitHub, nuovo progetto Netlify, variabili con PIN nuovi.

Per rigenerare Da Shaka: `python3 sorgenti/build.py` (usa `sorgenti/cliente.json`).

## Come funziona (in breve)

- **Prezzi sicuri:** il telefono invia solo codici e quantità; i prezzi li calcola il server.
- **Nessun doppio ordine** e **numeri senza doppioni** (#DS-0001, #DS-0002…), anche con più tavoli insieme.
- **Stati controllati:** Nuovo → In preparazione → Pronto → Servito (annullabile solo prima che sia pronto).
- **Privacy:** il cliente vede solo il proprio ordine; cucina e titolare hanno PIN separati (il PIN cucina non apre il pannello).

## Limiti di questa versione

- La cucina si aggiorna ogni 4 secondi (non istantaneo come con un database in tempo reale).
- Un solo PIN per la cucina e uno per il titolare (niente utenti separati).
- Le statistiche contano gli ordini inviati dal menu digitale, non quelli presi a voce o battuti in cassa.
