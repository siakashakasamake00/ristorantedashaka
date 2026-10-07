// Prenotazioni dei tavoli
//   POST  /api/prenotazioni  {day, time, ppl, name, phone, note, ref}   il cliente prenota con Marina      (pubblico)
//         con x-pin del titolare: prenotazione inserita a mano dal pannello (es. arrivata per telefono)
//   GET   /api/prenotazioni?dal=..&al=..                                   il titolare legge le prenotazioni  (ADMIN_PIN)
//   PATCH /api/prenotazioni  {id, status}                                  conferma / rifiuta / annulla       (ADMIN_PIN)
// Salvate in Netlify Blobs come "pren/<giorno>/<id>".
import { checkPin, day, json, loadSite, pinError, siteOrigin, store } from "../lib/menu.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATI = ["nuova", "confermata", "rifiutata", "annullata", "arrivata"];
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const weekday = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("it-IT", { weekday: "long", timeZone: "UTC" }).toLowerCase();

async function create(req) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const owner = checkPin(req, "ADMIN_PIN") === true;
  const d = String(b.day || ""), t = String(b.time || ""), ppl = Number(b.ppl);
  const name = clean(b.name, 60), phone = clean(b.phone, 25).replace(/[^\d+ ]/g, "").trim(), note = clean(b.note, 200);
  if (!DAY_RE.test(d) || isNaN(Date.parse(d))) return json({ error: "Data non valida" }, 400);
  if (!TIME_RE.test(t)) return json({ error: "Orario non valido" }, 400);
  if (!Number.isInteger(ppl) || ppl < 1 || ppl > 99) return json({ error: "Numero di persone non valido" }, 400);
  if (name.length < 2) return json({ error: "Scrivi il nome per la prenotazione" }, 400);
  if (!owner && phone.replace(/\D/g, "").length < 6) return json({ error: "Numero di telefono non valido" }, 400);
  const today = day();
  if (d < today) return json({ error: "La data è già passata" }, 400);
  if (d > day(new Date(Date.now() + 180 * 86400000))) return json({ error: "Si può prenotare al massimo 6 mesi prima" }, 400);
  if (!owner) {
    let site;
    try { site = await loadSite(siteOrigin(req)); } catch (e) { return json({ error: "Menu non leggibile: " + e.message }, 500); }
    const orario = (site.data.restaurant.opening_hours || []).find((h) => String(h.day).toLowerCase() === weekday(d));
    if (orario && /chius/i.test(orario.hours)) return json({ error: "Quel giorno il locale è chiuso" }, 400);
  }
  const s = store();
  const ref = /^[a-z0-9]{6,40}$/.test(String(b.ref || "")) ? b.ref : null;
  if (ref) {
    const old = await s.get(`pref/${ref}`, { type: "json" });
    if (old) return json({ ok: true, id: old.id, dup: true }, 200);
  }
  const id = `${d}_${rid()}`;
  if (ref) {
    const w = await s.setJSON(`pref/${ref}`, { id }, { onlyIfNew: true });
    if (!w.modified) return json({ ok: true, id: (await s.get(`pref/${ref}`, { type: "json" })).id, dup: true }, 200);
  }
  const rec = { id, day: d, time: t, ppl, name, phone, note, status: owner ? "confermata" : "nuova", src: owner ? "pannello" : "marina", createdAt: new Date().toISOString() };
  await s.setJSON(`pren/${d}/${id}`, rec);
  return json({ ok: true, id }, 201);
}

async function list(req) {
  const bad = pinError(checkPin(req, "ADMIN_PIN"), "ADMIN_PIN");
  if (bad) return bad;
  const u = new URL(req.url), today = day();
  const dal = DAY_RE.test(u.searchParams.get("dal") || "") ? u.searchParams.get("dal") : today;
  const al = DAY_RE.test(u.searchParams.get("al") || "") ? u.searchParams.get("al") : dal;
  const s = store();
  // conto delle nuove da oggi in avanti (per il numerino sulla scheda)
  if (u.searchParams.get("conta")) {
    const { blobs } = await s.list({ prefix: "pren/" });
    const keys = blobs.map((x) => x.key).filter((k) => k.slice(5, 15) >= today);
    const recs = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean);
    return json({ nuove: recs.filter((r) => r.status === "nuova").length });
  }
  const days = [], d = new Date(dal + "T12:00:00Z"), end = new Date(al + "T12:00:00Z");
  while (d <= end && days.length < 186) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const lists = await Promise.all(days.map(async (x) => {
    const { blobs } = await s.list({ prefix: `pren/${x}/` });
    return (await Promise.all(blobs.map((bl) => s.get(bl.key, { type: "json" })))).filter(Boolean);
  }));
  const items = lists.flat().sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time) || a.createdAt.localeCompare(b.createdAt));
  return json({ dal, al, items: items.slice(0, 1000) });
}

async function update(req) {
  const bad = pinError(checkPin(req, "ADMIN_PIN"), "ADMIN_PIN");
  if (bad) return bad;
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const m = /^(\d{4}-\d{2}-\d{2})_[a-z0-9]+$/.exec(String(b.id || ""));
  if (!m) return json({ error: "Prenotazione non valida" }, 400);
  if (!STATI.includes(b.status)) return json({ error: "Stato non valido" }, 400);
  const s = store(), key = `pren/${m[1]}/${b.id}`;
  const r = await s.get(key, { type: "json" });
  if (!r) return json({ error: "Prenotazione non trovata" }, 404);
  r.status = b.status; r.updatedAt = new Date().toISOString();
  await s.setJSON(key, r);
  return json({ ok: true, item: r });
}

export default async (req) => {
  try {
    if (req.method === "POST") return await create(req);
    if (req.method === "GET") return await list(req);
    if (req.method === "PATCH") return await update(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server" }, 500);
  }
};

export const config = { path: "/api/prenotazioni" };
