// Cameriere virtuale con l'API di Claude (conversazione vera), con riserva automatica "a parole chiave".
//
//   POST /api/chat   { turns:[{role,content}], table, sid }
//     → { text, azione }                         risposta dell'AI (azione = ordine ricalcolato o prenotazione controllata)
//     → { fallback:true, motivo }                il menu risponde da solo con le parole chiave (nessun costo)
//
// Motivi della riserva: ai_spenta, chiave_mancante, limite_sessione, troppi_messaggi, tetto_mensile, menu, api
//
// Variabili d'ambiente su Netlify:
//   ANTHROPIC_API_KEY   (obbligatoria, mai nel sito)
//   CHAT_MODEL          (facoltativa: sostituisce il modello della scheda cliente)
//
// Limiti e prezzi: netlify/lib/cliente-ai.mjs (generato da build.py dalla scheda cliente.json).
import Anthropic from "@anthropic-ai/sdk";
import { json, loadSite, siteOrigin, store } from "../lib/menu.mjs";
import CFG from "../lib/cliente-ai.mjs";
import { checkBooking, costUsd, fixPrices, monthIso, recalcOrder, splitReply, stablePrompt, volatilePrompt } from "../lib/chat-core.mjs";

const L = {
  modello: "claude-haiku-5-5", max_tokens: 600, max_messaggi_sessione: 20,
  max_messaggi_ip: 120, finestra_ip_minuti: 10, tetto_mensile_eur: 20, cambio_usd_eur: 0.92,
  prezzi_usd_mtok: { input: 0.10, output: 0.50 }, timeout_secondi: 8,
  ...(CFG.limiti || {}),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lettura-modifica-scrittura senza perdere aggiornamenti contemporanei (scrittura condizionata con etag)
async function bump(s, key, fn) {
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const next = fn(cur?.data || null);
    const w = await s.setJSON(key, next, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (w.modified) return next;
    await sleep(20 + Math.random() * 60);
  }
  throw new Error("Archivio occupato: " + key);
}

async function ipKey(req, context) {
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "sconosciuto";
  // l'indirizzo IP non viene salvato: solo un'impronta
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cameriere-ai|" + ip));
  return Array.from(new Uint8Array(h).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

const addUsage = (s, mese, patch) => bump(s, `ai/uso/${mese}`, (u) => {
  u = u || { conversazioni: 0, messaggi: 0, input: 0, output: 0, cache_scritti: 0, cache_letti: 0, costo_usd: 0, fallback: {} };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "fallback") u.fallback[v] = (u.fallback[v] || 0) + 1;
    else u[k] = (u[k] || 0) + v;
  }
  u.aggiornato = new Date().toISOString();
  return u;
});

// risposta di riserva: il menu userà le parole chiave
async function fallback(s, mese, motivo) {
  try { if (s) await addUsage(s, mese, { fallback: motivo }); } catch (e) { console.error("uso", e); }
  return json({ fallback: true, motivo });
}

let client = null;
function anthropic() {
  // ANTHROPIC_BASE_URL serve solo ai test locali con l'API simulata
  client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, maxRetries: 0, timeout: L.timeout_secondi * 1000 });
  return client;
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }

  // conversazione: solo ruoli validi, testi brevi, ultime 16 battute, inizia e finisce con il cliente
  let turns = (Array.isArray(body.turns) ? body.turns : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, 1500) }))
    .slice(-16);
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "Messaggio mancante" }, 400);
  const table = /^\d{1,3}$/.test(String(body.table ?? "")) ? Number(body.table) : null;
  const sid = /^[a-z0-9]{12,40}$/.test(String(body.sid || "")) ? String(body.sid) : null;
  if (!sid) return json({ error: "Sessione non valida" }, 400);

  const mese = monthIso();
  if (!CFG.ai) return fallback(null, mese, "ai_spenta");
  const s = store();
  if (!process.env.ANTHROPIC_API_KEY) return fallback(s, mese, "chiave_mancante");

  // 1. limite di messaggi per sessione (contato sul server, non nel telefono)
  let sess;
  try { sess = await bump(s, `ai/sess/${mese}/${sid}`, (x) => ({ n: (x?.n || 0) + 1, at: x?.at || new Date().toISOString() })); }
  catch (e) { console.error(e); return fallback(s, mese, "api"); }
  if (sess.n > L.max_messaggi_sessione) return fallback(s, mese, "limite_sessione");

  // 2. limite per indirizzo IP (finestra di N minuti)
  const win = Math.floor(Date.now() / (L.finestra_ip_minuti * 60000));
  const ipr = await bump(s, `ai/ip/${await ipKey(req, context)}`, (x) => (x?.win === win ? { win, n: x.n + 1 } : { win, n: 1 }));
  if (ipr.n > L.max_messaggi_ip) return fallback(s, mese, "troppi_messaggi");

  // 3. tetto di spesa del mese
  const uso = (await s.get(`ai/uso/${mese}`, { type: "json" })) || {};
  if ((uso.costo_usd || 0) * L.cambio_usd_eur >= L.tetto_mensile_eur) return fallback(s, mese, "tetto_mensile");

  // 4. istruzioni dal menu attuale (Netlify Blobs: prezzi, esauriti, allergeni) + scheda cliente
  let site;
  try { site = await loadSite(siteOrigin(req)); } catch (e) { console.error(e); return fallback(s, mese, "menu"); }

  // 5. chiamata all'API
  let msg;
  try {
    msg = await anthropic().messages.create({
      model: process.env.CHAT_MODEL || L.modello,
      max_tokens: L.max_tokens,
      output_config: { effort: "low" }, // risposte brevi da cameriere: poco ragionamento, meno costo
      system: [
        { type: "text", text: stablePrompt(site, CFG), cache_control: { type: "ephemeral" } },
        { type: "text", text: volatilePrompt(table) },
      ],
      messages: turns,
    });
  } catch (e) {
    console.error("API Anthropic:", e?.status || "", e?.message || e);
    return fallback(s, mese, "api");
  }

  const raw = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const usage = msg.usage || {};
  try {
    await addUsage(s, mese, {
      conversazioni: sess.n === 1 ? 1 : 0, messaggi: 1,
      input: usage.input_tokens || 0, output: usage.output_tokens || 0,
      cache_scritti: usage.cache_creation_input_tokens || 0, cache_letti: usage.cache_read_input_tokens || 0,
      costo_usd: costUsd(usage, L.prezzi_usd_mtok),
    });
  } catch (e) { console.error("uso", e); }
  if (!raw) return fallback(s, mese, "api"); // es. risposta vuota o rifiutata

  const { text, action } = splitReply(raw);
  const shown = fixPrices(text, site.byId);
  if (shown.fixed) console.warn("chat: corretti", shown.fixed, "prezzi/codici scritti dall'AI");

  let azione = null;
  if (action?.tipo === "ordine") azione = recalcOrder(action, site.byId);
  else if (action?.tipo === "prenotazione") azione = checkBooking(action, site.data.restaurant);

  return json({
    text: shown.text || "Scusa, non ho capito. Puoi ripetere?",
    azione,
    restanti: Math.max(0, L.max_messaggi_sessione - sess.n),
  });
};

export const config = { path: "/api/chat" };
