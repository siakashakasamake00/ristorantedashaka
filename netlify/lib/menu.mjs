// Funzioni condivise: archivio (Netlify Blobs), menu attuale, PIN, istruzioni del cameriere.
//
// Il menu di partenza è quello scritto dentro index.html. Appena il titolare fa una modifica
// dal pannello, il menu aggiornato viene salvato in Netlify Blobs ("menu/current") e da quel
// momento menu clienti, ordini (prezzi) e cameriere AI leggono tutti da lì.
import { getStore } from "@netlify/blobs";

export const ALLERGENS = ["Glutine", "Crostacei", "Uova", "Pesce", "Arachidi", "Soia", "Latte", "Frutta a guscio", "Sedano", "Senape", "Sesamo", "Solfiti", "Lupini", "Molluschi"];
export const TZ = "Europe/Rome";

export const store = () => getStore({ name: "ristorante", consistency: "strong" });
export const day = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: TZ }); // 2026-09-28

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export function siteOrigin(req) {
  return process.env.URL || new URL(req.url).origin;
}

// ---------- PIN (confronto a tempo costante) ----------
export function checkPin(req, envName) {
  const pin = process.env[envName];
  if (!pin) return null; // non configurato
  const given = req.headers.get("x-pin") || "";
  if (given.length !== pin.length) return false;
  let diff = 0;
  for (let i = 0; i < pin.length; i++) diff |= pin.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
export function pinError(ok, envName) {
  if (ok === null) return json({ error: `${envName} non configurato su Netlify` }, 503);
  if (!ok) return json({ error: "PIN errato" }, 401);
  return null;
}

// ---------- menu di partenza (da index.html) ----------
let base = { at: 0, v: null };
async function loadBase(origin) {
  if (base.v && Date.now() - base.at < 10 * 60 * 1000) return base.v;
  const res = await fetch(origin + "/index.html", { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error("index.html non raggiungibile (" + res.status + ")");
  const html = await res.text();
  const pick = (id) => {
    const m = new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
    if (!m) throw new Error("Blocco " + id + " non trovato in index.html");
    return m[1].replace(/<\\\//g, "</");
  };
  base = { at: Date.now(), v: { data: JSON.parse(pick("menu-data")), rules: pick("marina-rules") } };
  return base.v;
}

// ---------- menu attuale ----------
let cur = { at: 0, v: null };
export async function loadSite(origin, { fresh = false } = {}) {
  if (!fresh && cur.v && Date.now() - cur.at < 10 * 1000) return cur.v;
  const b = await loadBase(origin);
  let saved = null;
  try { saved = await store().get("menu/current", { type: "json" }); } catch (e) { console.error("menu/current", e); }
  let data = saved?.data || b.data;
  // sezioni nuove arrivate con un aggiornamento del sito (es. "Menu del giorno"): si aggiungono al menu salvato dal titolare,
  // senza toccare le sue modifiche. Una sezione che il titolare ha cancellato non torna (è in baseCats).
  if (saved?.data) {
    const known = new Set([...(saved.baseCats || []), ...saved.data.categories.map((c) => c.name)]);
    const ids = new Set(saved.data.categories.flatMap((c) => c.items.map((p) => p.id)));
    const add = b.data.categories.map((c, i) => ({ c, i })).filter(({ c }) => !known.has(c.name));
    if (add.length) {
      const cats = saved.data.categories.slice();
      for (const { c, i } of add) cats.splice(Math.min(i, cats.length), 0, { ...c, items: c.items.filter((p) => !ids.has(p.id)) });
      data = { ...saved.data, categories: cats };
    }
  }
  const byId = {};
  data.categories.forEach((c) => c.items.forEach((p) => (byId[p.id] = { ...p, cat: c.name })));
  cur = { at: Date.now(), v: { data, byId, rules: b.rules, version: saved?.version || 0, updatedAt: saved?.updatedAt || null } };
  return cur.v;
}

export async function saveMenu(origin, data, baseVersion) {
  const now = await loadSite(origin, { fresh: true });
  if (Number(baseVersion) !== now.version) {
    const e = new Error("Il menu è stato modificato da un altro dispositivo: ricarica la pagina");
    e.status = 409;
    throw e;
  }
  const base = await loadBase(origin);
  const rec = { data, version: now.version + 1, updatedAt: new Date().toISOString(), baseCats: base.data.categories.map((c) => c.name) };
  await store().setJSON("menu/current", rec);
  cur = { at: 0, v: null };
  return rec;
}

// ---------- istruzioni del cameriere AI ----------
const euro = (n) => (Math.round(n * 100) / 100).toFixed(2);
export function buildRules({ data, rules }, table) {
  const R = data.restaurant;
  const locale =
    `${R.name} – ${R.tagline}. ${R.address}, ${R.postal_code} ${R.city} (${R.province}). Tel ${R.phone}, ${R.email}, ${R.website}.\n` +
    `Orari: ${(R.opening_hours || []).map((h) => `${h.day} ${h.hours}`).join("; ")}. Chiusura: ${R.closing_days}\n` +
    `Coperti ${R.seats}, tavoli ${R.tables_count}. Servizi: ${(R.services || []).join("; ")}.\nInfo: ${R.info}\n` +
    (R.takeaway_on ? `Asporto: attivo. Si ordina da questo menu scegliendo "Da asporto" nel riepilogo (nome, telefono, orario di ritiro); pronto in almeno ${R.takeaway_min || 20} minuti, si paga al ritiro.` : "Asporto: non disponibile dal menu digitale.");
  const menu = data.categories
    .map((c) => `## ${c.name}\n` + c.items
      .map((p) => `${p.id} | ${p.name} | ${euro(p.price)} | ${(p.all || []).join(", ") || "-"} | ${p.veg ? "V" : "-"} | ${p.av ? "disponibile" : "ESAURITO"} | ${p.desc}`)
      .join("\n"))
    .join("\n");
  return rules.replace("{{LOCALE}}", locale).replace("{{TAVOLO}}", table ? String(table) : "non indicato").replace("{{MENU}}", menu);
}

// ---------- storico ordini (condiviso da statistiche e "più ordinati") ----------
export const compact = (o) => ({
  code: o.code, type: o.type || "tavolo", table: o.table, pickup: o.pickup || null, createdAt: o.createdAt, status: o.status, total: o.total, note: o.note || "",
  items: (o.items || []).map((i) => ({ id: i.id, name: i.name, cat: i.cat || "", qty: i.qty, price: i.price })),
  prepMin: o.times?.ready ? Math.round((Date.parse(o.times.ready) - Date.parse(o.createdAt)) / 60000) : null,
});

// Gli ordini dei giorni passati vengono riassunti una volta sola in "sum/<data>" per essere veloci
const mem = new Map();
export async function ordersOfDay(s, d, today, yesterday) {
  const closed = d < yesterday;
  if (closed) {
    if (mem.has(d)) return mem.get(d);
    const sum = await s.get(`sum/${d}`, { type: "json" });
    if (sum) { mem.set(d, sum); return sum; }
  }
  const { blobs } = await s.list({ prefix: `o/${d}/` });
  const list = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean).map(compact);
  if (closed) { await s.setJSON(`sum/${d}`, list); mem.set(d, list); }
  return list;
}


// ---------- piatti più ordinati degli ultimi 14 giorni (ricalcolati al massimo ogni 30 minuti) ----------
let topMem = { at: 0, ids: [] };
export async function topSellers() {
  if (Date.now() - topMem.at < 30 * 60 * 1000) return topMem.ids;
  const s = store();
  try {
    const saved = await s.get("top/current", { type: "json" });
    if (saved && Date.now() - saved.at < 30 * 60 * 1000) { topMem = saved; return saved.ids; }
  } catch {}
  const today = day(), yesterday = day(new Date(Date.now() - 86400000)), days = [];
  for (let k = 0; k < 14; k++) days.push(day(new Date(Date.now() - k * 86400000)));
  const qty = {};
  try {
    const lists = await Promise.all(days.map((d) => ordersOfDay(s, d, today, yesterday)));
    for (const o of lists.flat()) if (o.status !== "cancelled") for (const i of o.items || []) qty[i.id] = (qty[i.id] || 0) + i.qty;
  } catch (e) { console.error("top", e); }
  const ids = Object.keys(qty).sort((a, b) => qty[b] - qty[a]).slice(0, 12);
  topMem = { at: Date.now(), ids };
  try { await s.setJSON("top/current", topMem); } catch {}
  return ids;
}
