// GENERATO da sorgenti/build.py partendo da cliente.json: non modificarlo a mano.
export default {
  "ai": true,
  "tipo_locale": "ristorante di pesce",
  "cameriere": {
    "nome": "Marina",
    "ruolo": "la cameriera virtuale",
    "carattere": "Sei calda, accogliente e un po' marinara; dai del tu con garbo."
  },
  "limiti": {
    "modello": "claude-haiku-5-5",
    "max_tokens": 600,
    "max_messaggi_sessione": 20,
    "max_messaggi_ip": 120,
    "finestra_ip_minuti": 10,
    "tetto_mensile_eur": 20,
    "cambio_usd_eur": 0.92,
    "timeout_secondi": 8,
    "prezzi_usd_mtok": {
      "input": 0.1,
      "output": 0.5,
      "cache_write": 0.125,
      "cache_read": 0.01
    }
  }
};
