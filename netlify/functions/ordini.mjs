// Ordini dal tavolo
// Salvataggio su Netlify Blobs (nessun database esterno).
//
//   POST  /api/ordini                  il menu invia un ordine            (pubblico)
//   GET   /api/ordini?id=..&t=..       il cliente segue lo stato          (pubblico, con codice segreto)
//   GET   /api/ordini                  la cucina legge gli ordini         (PIN)
//   PATCH /api/ordini  {id, status}    la cucina cambia lo stato          (PIN)
//
// Variabili d'ambiente su Netlify:
//   KITCHEN_PIN   PIN della dashboard cucina (obbligatoria, 6 cifre)
import { checkPin, day, json, loadSite, pinError, siteOrigin, store } from "../lib/menu.mjs";

const STATUSES = ["new", "preparing", "ready", "served", "cancelled"];
const NEXT = { new: ["preparing", "cancelled"], preparing: ["ready", "cancelled"], ready: ["served"] };
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const keyOf = (id) => {
  const m = /^(\d{4}-\d{2}-\d{2})_[a-z0-9]+$/.exec(String(id || ""));
  return m ? `o/${m[1]}/${id}` : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// Versione pubblica dell'ordine (senza il codice segreto per il cliente)
const publicOrder = ({ token, ...o }) => o;

// Numero progressivo #DS-0001 senza duplicati, anche con ordini simultanei:
// ogni numero viene "prenotato" con una scrittura che riesce solo se la chiave non esiste ancora.
async function nextNumber(s, orderId) {
  const hint = Number((await s.get("counter", { type: "json" }))?.n) || 0;
  for (let n = hint + 1; n <= hint + 200; n++) {
    const w = await s.setJSON(`num/${String(n).padStart(6, "0")}`, { id: orderId }, { onlyIfNew: true });
    if (w.modified) {
      await s.setJSON("counter", { n }); // solo un suggerimento per partire dal punto giusto
      return n;
    }
  }
  throw new Error("Numerazione ordini non disponibile, riprova");
}

async function readOrder(s, id) {
  const k = keyOf(id);
  return k ? s.getWithMetadata(k, { type: "json" }) : null;
}

// ---------------------------------------------------------------- POST: nuovo ordine
async function createOrder(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }

  let site;
  try { site = await loadSite(siteOrigin(req)); } catch (e) { return json({ error: "Menu non leggibile: " + e.message }, 500); }
  const R = site.data.restaurant;

  const asporto = body.type === "asporto";
  let table = null, pickup = null;
  if (asporto) {
    if (!R.takeaway_on) return json({ error: "Al momento l'asporto non è attivo" }, 400);
    const oggi = new Date().toLocaleDateString("it-IT", { weekday: "long", timeZone: "Europe/Rome" }).toLowerCase();
    const orario = (R.opening_hours || []).find((h) => String(h.day).toLowerCase() === oggi);
    if (orario && /chius/i.test(orario.hours)) return json({ error: "Oggi il locale è chiuso: l'asporto non è disponibile, puoi prenotare un tavolo" }, 400);
    if (orario) {
      const [hh, mm] = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Rome" }).split(":").map(Number);
      const nowM = hh * 60 + mm, OB = R.takeaway_open_before ?? 30, CB = R.takeaway_close_before ?? 30;
      const [ph, pm] = String(body.time || "").split(":").map(Number), pick = ph * 60 + pm;
      const ranges = [...String(orario.hours).matchAll(/(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/g)].map((m) => { const o = +m[1] * 60 + +m[2]; let c = +m[3] * 60 + +m[4]; if (c <= o) c += 1440; return [o, c]; });
      const ok = !ranges.length || ranges.some(([o, c]) => nowM >= o - OB && nowM <= c - CB && pick >= o && pick <= c - CB && pick >= nowM);
      if (!ok) return json({ error: "Orario di ritiro non disponibile: gli ordini da asporto si aprono mezz'ora prima dell'apertura e chiudono mezz'ora prima della chiusura" }, 400);
    }
    const name = clean(body.name, 60), phone = String(body.phone || "").replace(/[^\d+ ]/g, "").trim().slice(0, 20), time = String(body.time || "");
    if (name.length < 2) return json({ error: "Scrivi il tuo nome per il ritiro" }, 400);
    if (phone.replace(/\D/g, "").length < 6) return json({ error: "Numero di telefono non valido" }, 400);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json({ error: "Orario di ritiro non valido" }, 400);
    pickup = { name, phone, time };
  } else {
    table = Number(body.table);
    if (!Number.isInteger(table) || table < 1 || table > (R.tables_count || 20)) return json({ error: "Numero del tavolo non valido" }, 400);
  }

  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return json({ error: "Il carrello è vuoto" }, 400);
  if (raw.length > 40) return json({ error: "Troppe righe nell'ordine" }, 400);

  const items = [];
  for (const it of raw) {
    const p = site.byId[String(it?.id || "")];
    const q = Number(it?.q);
    if (!p) return json({ error: "Un prodotto non è più nel menu: aggiorna la pagina" }, 400);
    if (!p.av) return json({ error: `"${p.name}" oggi non è disponibile` }, 409);
    if (!Number.isInteger(q) || q < 1 || q > 20) return json({ error: "Quantità non valida" }, 400);
    items.push({ id: p.id, name: p.name, cat: p.cat, qty: q, price: p.price, note: clean(it.nota, 200) }); // prezzo SEMPRE dal menu
  }
  const total = Math.round(items.reduce((s, i) => s + i.qty * i.price, 0) * 100) / 100;
  const ref = /^[a-z0-9-]{16,64}$/i.test(String(body.ref || "")) ? String(body.ref) : null;

  const s = store();

  // stesso carrello inviato due volte (doppio tocco, rete lenta): restituisce l'ordine già creato
  const fromRef = async () => {
    for (let i = 0; i < 10; i++) {
      const r = await s.get(`ref/${ref}`, { type: "json" });
      if (r?.id) {
        const o = await readOrder(s, r.id);
        if (o?.data) return json({ ...publicOrder(o.data), token: o.data.token, duplicate: true });
      }
      await sleep(150);
    }
    return json({ error: "Ordine in elaborazione, riprova tra un attimo" }, 409);
  };
  if (ref && (await s.get(`ref/${ref}`, { type: "json" }))) return fromRef();

  const now = new Date();
  const id = `${day(now)}_${now.getTime().toString(36)}${rand(3)}`;
  if (ref) {
    const w = await s.setJSON(`ref/${ref}`, { id }, { onlyIfNew: true });
    if (!w.modified) return fromRef();
  }

  let n;
  try { n = await nextNumber(s, id); } catch (e) { return json({ error: e.message }, 503); }

  const order = {
    id,
    code: `${R.order_prefix || "ORD"}-${String(n).padStart(4, "0")}`,
    number: n,
    type: asporto ? "asporto" : "tavolo",
    table,
    pickup,
    items,
    note: clean(body.note, 300),
    total,
    status: "new",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    token: rand(12),
  };
  await s.setJSON(keyOf(id), order);
  return json({ ...publicOrder(order), token: order.token }, 201);
}

// ---------------------------------------------------------------- GET cucina: ordini di oggi e ieri
const listCache = new Map(); // key -> {etag, data}
async function listOrders() {
  const s = store();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const blobs = [];
  for (const d of [day(yesterday), day(today)]) {
    const { blobs: b } = await s.list({ prefix: `o/${d}/` });
    blobs.push(...b);
  }
  const out = await Promise.all(
    blobs.map(async ({ key, etag }) => {
      const c = listCache.get(key);
      if (c && c.etag === etag) return c.data;
      const data = await s.get(key, { type: "json" });
      if (data) listCache.set(key, { etag, data });
      return data;
    }),
  );
  const cutoff = Date.now() - 16 * 3600000;
  return out
    .filter(Boolean)
    .filter((o) => ["new", "preparing", "ready"].includes(o.status) || Date.parse(o.createdAt) > cutoff)
    .map(publicOrder)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------- PATCH cucina: cambio stato
async function updateStatus(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const to = String(body.status || "");
  if (!STATUSES.includes(to)) return json({ error: "Stato non valido" }, 400);
  const s = store();
  const k = keyOf(body.id);
  if (!k) return json({ error: "Ordine non trovato" }, 404);
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(k, { type: "json" });
    if (!cur) return json({ error: "Ordine non trovato" }, 404);
    const o = cur.data;
    if (o.status === to) return json(publicOrder(o));
    if (!(NEXT[o.status] || []).includes(to)) return json({ error: `Passaggio non consentito: ${o.status} → ${to}` }, 409);
    const at = new Date().toISOString();
    const upd = { ...o, status: to, updatedAt: at, times: { ...(o.times || {}), [to]: at } };
    const w = await s.setJSON(k, upd, { onlyIfMatch: cur.etag });
    if (w.modified) return json(publicOrder(upd));
    await sleep(50);
  }
  return json({ error: "Ordine modificato da un altro dispositivo, riprova" }, 409);
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "POST") return await createOrder(req);

    if (req.method === "GET" && url.searchParams.get("id")) {
      // il cliente segue il proprio ordine
      const o = await readOrder(store(), url.searchParams.get("id"));
      if (!o?.data || o.data.token !== url.searchParams.get("t")) return json({ error: "Ordine non trovato" }, 404);
      return json(publicOrder(o.data)); // solo chi ha il codice segreto dell'ordine
    }

    const bad = pinError(checkPin(req, "KITCHEN_PIN"), "KITCHEN_PIN");
    if (bad) return bad;

    if (req.method === "GET") return json({ orders: await listOrders(), now: new Date().toISOString() });
    if (req.method === "PATCH") return await updateStatus(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server: " + (e?.message || e) }, 500);
  }
};

export const config = { path: "/api/ordini" };
