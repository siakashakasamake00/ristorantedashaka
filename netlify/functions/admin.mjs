// Pannello titolare: statistiche e storico ordini (ADMIN_PIN)
//   GET /api/admin?azione=verifica
//   GET /api/admin?azione=stats&dal=2026-09-01&al=2026-09-28
//   GET /api/admin?azione=ordini&dal=...&al=...
//   GET /api/admin?azione=ai&mese=2026-10           cameriere AI: conversazioni e costo stimato del mese
import { TZ, checkPin, day, json, ordersOfDay, pinError, store } from "../lib/menu.mjs";
import CFG from "../lib/cliente-ai.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const hourOf = (iso) => Number(new Date(iso).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false })) % 24;

function daysBetween(dal, al) {
  const out = [];
  const d = new Date(dal + "T12:00:00Z"), end = new Date(al + "T12:00:00Z");
  while (d <= end && out.length < 92) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function stats(orders, days) {
  const valid = orders.filter((o) => o.status !== "cancelled");
  const revenue = valid.reduce((s, o) => s + o.total, 0);
  const byHour = Array.from({ length: 24 }, (_, h) => ({ h, orders: 0, revenue: 0 }));
  const byDay = Object.fromEntries(days.map((d) => [d, { date: d, orders: 0, revenue: 0 }]));
  const prod = {}, cat = {}, tab = {};
  let itemsSold = 0, prepSum = 0, prepN = 0;
  const takeaway = { orders: 0, revenue: 0 };
  for (const o of valid) {
    const h = byHour[hourOf(o.createdAt)]; h.orders++; h.revenue += o.total;
    const d = byDay[day(new Date(o.createdAt))]; if (d) { d.orders++; d.revenue += o.total; }
    const tk = o.type === "asporto" ? "asporto" : o.table;
    const t = (tab[tk] ||= { table: tk, orders: 0, revenue: 0 }); t.orders++; t.revenue += o.total;
    if (o.type === "asporto") { takeaway.orders++; takeaway.revenue += o.total; }
    if (o.prepMin != null && o.prepMin >= 0 && o.prepMin < 240) { prepSum += o.prepMin; prepN++; }
    for (const i of o.items) {
      itemsSold += i.qty;
      const p = (prod[i.id + "|" + i.name] ||= { id: i.id, name: i.name, qty: 0, revenue: 0 }); p.qty += i.qty; p.revenue += i.qty * i.price;
      const c = (cat[i.cat || "Altro"] ||= { cat: i.cat || "Altro", qty: 0, revenue: 0 }); c.qty += i.qty; c.revenue += i.qty * i.price;
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    orders: valid.length,
    cancelled: orders.length - valid.length,
    revenue: r2(revenue),
    avgTicket: valid.length ? r2(revenue / valid.length) : 0,
    itemsSold,
    takeaway: { orders: takeaway.orders, revenue: r2(takeaway.revenue) },
    avgPrepMin: prepN ? Math.round(prepSum / prepN) : null,
    byHour: byHour.map((x) => ({ ...x, revenue: r2(x.revenue) })),
    byDay: Object.values(byDay).map((x) => ({ ...x, revenue: r2(x.revenue) })),
    topProducts: Object.values(prod).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue).slice(0, 15).map((x) => ({ ...x, revenue: r2(x.revenue) })),
    byCategory: Object.values(cat).sort((a, b) => b.revenue - a.revenue).map((x) => ({ ...x, revenue: r2(x.revenue) })),
    byTable: Object.values(tab).sort((a, b) => b.revenue - a.revenue).map((x) => ({ ...x, revenue: r2(x.revenue) })),
  };
}

export default async (req) => {
  const bad = pinError(checkPin(req, "ADMIN_PIN"), "ADMIN_PIN");
  if (bad) return bad;
  const url = new URL(req.url);
  const azione = url.searchParams.get("azione");
  if (azione === "verifica") return json({ ok: true });
  if (azione === "ai") {
    const mese = /^\d{4}-\d{2}$/.test(url.searchParams.get("mese") || "") ? url.searchParams.get("mese") : day().slice(0, 7);
    const L = CFG.limiti || {};
    const u = (await store().get(`ai/uso/${mese}`, { type: "json" })) || {};
    const r2 = (n) => Math.round(n * 100) / 100;
    return json({
      attivo: !!CFG.ai && !!process.env.ANTHROPIC_API_KEY, ai: !!CFG.ai, chiave: !!process.env.ANTHROPIC_API_KEY, mese,
      conversazioni: u.conversazioni || 0, messaggi: u.messaggi || 0,
      costo_eur: r2((u.costo_usd || 0) * (L.cambio_usd_eur ?? 0.92)), tetto_eur: L.tetto_mensile_eur ?? 20,
      fallback: u.fallback || {}, token: { input: u.input || 0, output: u.output || 0, cache_scritti: u.cache_scritti || 0, cache_letti: u.cache_letti || 0 },
    });
  }

  const today = day(), yesterday = day(new Date(Date.now() - 86400000));
  const dal = DAY_RE.test(url.searchParams.get("dal") || "") ? url.searchParams.get("dal") : today;
  const al = DAY_RE.test(url.searchParams.get("al") || "") ? url.searchParams.get("al") : today;
  if (dal > al) return json({ error: "Intervallo di date non valido" }, 400);
  const days = daysBetween(dal, al < today ? al : today);

  try {
    const s = store();
    const orders = (await Promise.all(days.map((d) => ordersOfDay(s, d, today, yesterday)))).flat();
    if (azione === "stats") return json({ dal, al, ...stats(orders, days) });
    if (azione === "ordini") {
      orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ dal, al, orders: orders.slice(0, 3000) });
    }
    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server: " + (e?.message || e) }, 500);
  }
};

export const config = { path: "/api/admin" };
