// Menu attuale del ristorante
//   GET /api/menu        menu + dati del locale (pubblico: lo usano menu clienti, cucina, QR)
//   PUT /api/menu        il titolare salva le modifiche (ADMIN_PIN)   body: { data, baseVersion }
import { ALLERGENS, checkPin, json, loadSite, pinError, saveMenu, siteOrigin, topSellers } from "../lib/menu.mjs";

const str = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

// Controlla e ripulisce tutto ciò che arriva dal pannello
function validate(input) {
  const R = input?.restaurant, cats = input?.categories;
  if (!R || typeof R !== "object") throw new Error("Dati del locale mancanti");
  if (!Array.isArray(cats) || !cats.length || cats.length > 20) throw new Error("Categorie non valide");
  const restaurant = {
    ...R,
    name: str(R.name, 60) || "Ristorante",
    tagline: str(R.tagline, 80),
    order_prefix: (str(R.order_prefix, 4).toUpperCase().replace(/[^A-Z]/g, "") || "ORD"),
    address: str(R.address, 120), postal_code: str(R.postal_code, 10), city: str(R.city, 60),
    province: str(R.province, 4), region: str(R.region, 40), country: str(R.country, 40),
    google_review_url: /^https:\/\/[^\s"'<>]+$/.test(String(R.google_review_url || "").trim()) ? str(R.google_review_url, 300) : "",
    phone: str(R.phone, 40), whatsapp: str(R.whatsapp, 30), email: str(R.email, 80), website: str(R.website, 120),
    description: str(R.description, 1200), closing_days: str(R.closing_days, 300), info: str(R.info, 800),
    seats: Math.max(0, Math.min(2000, parseInt(R.seats, 10) || 0)),
    hero: typeof R.hero === "string" && /^\/api\/foto\?id=COPERTINA&v=\d+$/.test(R.hero) ? R.hero : null,
    waiter_img: typeof R.waiter_img === "string" && /^\/api\/foto\?id=AVATAR&v=\d+$/.test(R.waiter_img) ? R.waiter_img : null,
    logo: typeof R.logo === "string" && /^\/api\/foto\?id=LOGO&v=\d+$/.test(R.logo) ? R.logo : null,
    takeaway_on: !!R.takeaway_on,
    takeaway_min: Math.max(5, Math.min(180, parseInt(R.takeaway_min, 10) || 20)),
    takeaway_open_before: Math.max(0, Math.min(180, Number.isFinite(parseInt(R.takeaway_open_before, 10)) ? parseInt(R.takeaway_open_before, 10) : 30)),
    takeaway_close_before: Math.max(0, Math.min(180, Number.isFinite(parseInt(R.takeaway_close_before, 10)) ? parseInt(R.takeaway_close_before, 10) : 30)),
    tables_count: Math.max(1, Math.min(200, parseInt(R.tables_count, 10) || 1)),
    opening_hours: (Array.isArray(R.opening_hours) ? R.opening_hours : []).slice(0, 7).map((h) => ({ day: str(h?.day, 20), hours: str(h?.hours, 60) })),
    services: (Array.isArray(R.services) ? R.services : []).map((s) => str(s, 80)).filter(Boolean).slice(0, 30),
  };
  const ids = new Set();
  let total = 0;
  const categories = cats.map((c) => {
    const items = (Array.isArray(c?.items) ? c.items : []).map((p) => {
      const id = str(p?.id, 8).toUpperCase();
      if (!/^[A-Z]{1,2}\d{2,3}$/.test(id)) throw new Error("Codice prodotto non valido: " + id);
      if (ids.has(id)) throw new Error("Codice prodotto duplicato: " + id);
      ids.add(id);
      const name = str(p.name, 90);
      if (!name) throw new Error("Un prodotto non ha il nome");
      const price = Math.round(Number(p.price) * 100) / 100;
      if (!Number.isFinite(price) || price < 0 || price > 5000) throw new Error(`Prezzo non valido per "${name}"`);
      const img = typeof p.img === "string" && /^\/api\/foto\?id=[A-Z0-9]+&v=\d+$/.test(p.img) ? p.img : null;
      return {
        id, name, price, img,
        desc: str(p.desc, 300),
        all: (Array.isArray(p.all) ? p.all : []).filter((a) => ALLERGENS.includes(a)),
        veg: !!p.veg,
        star: !!p.star,
        av: p.av !== false,
      };
    });
    total += items.length;
    return { name: str(c.name, 40) || "Categoria", items };
  });
  if (total > 400) throw new Error("Troppi prodotti (massimo 400)");
  return { restaurant, categories };
}

export default async (req) => {
  const origin = siteOrigin(req);
  try {
    if (req.method === "GET") {
      const s = await loadSite(origin);
      let top = [];
      try { top = (await topSellers()).filter((id) => s.byId[id]); } catch {}
      return json({ data: s.data, version: s.version, updatedAt: s.updatedAt, top });
    }
    if (req.method === "PUT") {
      const bad = pinError(checkPin(req, "ADMIN_PIN"), "ADMIN_PIN");
      if (bad) return bad;
      let body;
      try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
      let data;
      try { data = validate(body.data); } catch (e) { return json({ error: e.message }, 400); }
      const rec = await saveMenu(origin, data, body.baseVersion);
      return json({ version: rec.version, updatedAt: rec.updatedAt });
    }
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    return json({ error: e.message || "Errore del server" }, e.status || 500);
  }
};

export const config = { path: "/api/menu" };
