// Vecchio indirizzo del cameriere AI, sostituito da /api/chat (netlify/functions/chat.js) con limiti e tetto di spesa.
// Resta solo per i telefoni che hanno ancora in memoria la pagina vecchia: rispondendo con un errore,
// la pagina vecchia passa da sola alle risposte a parole chiave (nessuna chiamata all'API, nessun costo).
import { json } from "../lib/menu.mjs";

export default async () => json({ error: "Aggiorna la pagina" }, 410);

export const config = { path: "/api/marina" };
