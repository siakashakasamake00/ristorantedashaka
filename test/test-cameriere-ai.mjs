// Test locale del cameriere AI, senza Netlify e senza chiave vera:
//   - Netlify Blobs: server locale ufficiale (@netlify/blobs → BlobsServer) in una cartella temporanea
//   - API Anthropic: server simulato su localhost (ANTHROPIC_BASE_URL), risposte scritte dal test
//   - le funzioni chat.js, menu-api.mjs e admin.mjs sono quelle vere
//
// Uso (dalla cartella del sito):   npm install   poi   node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${srv.address().port}`)));

// ---------- API Anthropic simulata ----------
const MOCK = { mode: "ok", reply: "Ciao!", usage: { input_tokens: 300, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 }, last: null, calls: 0 };
const api = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    MOCK.calls++;
    MOCK.last = JSON.parse(b || "{}");
    if (MOCK.mode === "close") return req.socket.destroy(); // server irraggiungibile / connessione caduta
    if (MOCK.mode === "down") {
      res.writeHead(529, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: MOCK.last.model,
      content: [{ type: "text", text: MOCK.reply }], stop_reason: "end_turn", stop_sequence: null, usage: MOCK.usage,
    }));
  });
});

// ---------- il sito (serve index.html: il menu di partenza) ----------
const site = http.createServer((req, res) => {
  if (req.url.startsWith("/index.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(fs.readFileSync(path.join(ROOT, "index.html"))); }
  res.writeHead(404); res.end();
});

let blobs, tmp, chat, menuApi, admin, mese;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blobs-"));
  blobs = new BlobsServer({ directory: tmp, token: "tok" });
  const { port } = await blobs.start();
  const edge = `http://127.0.0.1:${port}`;
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: "sito-test", token: "tok", edgeURL: edge, uncachedEdgeURL: edge })).toString("base64");
  process.env.URL = await listen(site);
  process.env.ANTHROPIC_BASE_URL = await listen(api);
  process.env.ANTHROPIC_API_KEY = "sk-test-finta";
  process.env.ADMIN_PIN = "12345678";
  chat = (await import("../netlify/functions/chat.js")).default;
  menuApi = (await import("../netlify/functions/menu-api.mjs")).default;
  admin = (await import("../netlify/functions/admin.mjs")).default;
  mese = (await import("../netlify/lib/chat-core.mjs")).monthIso();
});
after(async () => { api.close(); site.close(); await blobs.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
const sid = () => ("sessionetest" + (++n) + "x".repeat(10)).slice(0, 24);
const ask = async (text, { s = sid(), ip = "10.0.0." + n, table = 7 } = {}) => {
  const r = await chat(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify({ turns: [{ role: "user", content: text }], table, sid: s }) }), { ip });
  return { status: r.status, ...(await r.json()) };
};
const menuGet = async () => (await menuApi(new Request("http://x/api/menu"))).json();
const menuPut = async (data, baseVersion) => menuApi(new Request("http://x/api/menu", { method: "PUT", headers: { "x-pin": "12345678" }, body: JSON.stringify({ data, baseVersion }) }));
const find = (data, id) => data.categories.flatMap((c) => c.items).find((p) => p.id === id);

test("il prompt nasce dal menu salvato: prezzo cambiato e piatto esaurito nel pannello arrivano subito al cameriere", async () => {
  const m = await menuGet();
  const data = structuredClone(m.data);
  find(data, "P01").price = 99.5;
  find(data, "A02").av = false;
  const r = await menuPut(data, m.version);
  assert.equal(r.status, 200, await r.clone().text());

  MOCK.mode = "ok"; MOCK.reply = "Ecco!";
  await ask("Cosa mi consigli?");
  const sys = MOCK.last.system.map((b) => b.text).join("\n");
  const p01 = sys.split("\n").find((l) => l.startsWith("P01 |"));
  const a02 = sys.split("\n").find((l) => l.startsWith("A02 |"));
  assert.match(p01, /€ 99,50/, "il nuovo prezzo è nel prompt");
  assert.match(a02, /ESAURITO/, "il piatto esaurito è segnato nel prompt");
  // tutti i prodotti del menu salvato, nessuno scritto a mano
  const total = data.categories.reduce((s, c) => s + c.items.length, 0);
  assert.equal(sys.split("\n").filter((l) => /^[A-Z]{1,2}\d{2,3} \| /.test(l)).length, total);
  // dati della scheda cliente e del locale
  assert.match(sys, /Sei Marina, la cameriera virtuale di Da Shaka/);
  assert.match(sys, /Via Roma 111/);
  assert.match(sys, /Martedì 19:00/);
  assert.match(sys, /TAVOLO: 7/);
  // parametri di costo
  assert.equal(MOCK.last.model, "claude-haiku-5-5");
  assert.ok(MOCK.last.max_tokens <= 600);
  assert.deepEqual(MOCK.last.system[0].cache_control, { type: "ephemeral" });
});

test("ricalcolo dei totali: il server ignora prezzi e totali scritti dall'AI", async () => {
  const { data } = await menuGet();
  const a01 = find(data, "A01");
  MOCK.mode = "ok";
  MOCK.reply = 'Perfetto! Spaghetti alle vongole veraci [P01] – € 3,00 e un antipasto [A01] a 1 €. Totale € 7.\n' +
    '<azione>{"tipo":"ordine","totale":7,"righe":[{"id":"P01","q":2,"prezzo":1.5},{"id":"A01","q":1,"prezzo":1},{"id":"Z99","q":1},{"id":"A02","q":1}]}</azione>';
  const r = await ask("Prendo due spaghetti e un antipasto");
  assert.equal(r.azione.tipo, "ordine");
  assert.equal(r.azione.totale, Math.round((2 * 99.5 + a01.price) * 100) / 100);
  assert.deepEqual(r.azione.righe.map((x) => [x.id, x.q, x.prezzo]), [["P01", 2, 99.5], ["A01", 1, a01.price]]);
  assert.deepEqual(r.azione.scartati.map((x) => [x.id, x.motivo]), [["Z99", "non è nel menu"], ["A02", "esaurito"]]);
  assert.doesNotMatch(r.text, /<azione/);
  assert.match(r.text, /\[P01\] – € 99,50/, "prezzo sbagliato corretto nel testo");
  assert.match(r.text, new RegExp("\\[A01\\] a € " + a01.price.toFixed(2).replace(".", ",")));
});

test("prenotazione: dati controllati dal server (giorno di chiusura rifiutato)", async () => {
  // prossimo lunedì (Da Shaka è chiuso) e prossimo venerdì
  const next = (wd) => { const d = new Date(); do d.setDate(d.getDate() + 1); while (d.getDay() !== wd); return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }); };
  MOCK.reply = `Ti preparo la richiesta.\n<azione>{"tipo":"prenotazione","giorno":"${next(5)}","ora":"20:30","persone":4,"nome":"Luca","telefono":"333 1234567"}</azione>`;
  let r = await ask("Prenoto venerdì");
  assert.equal(r.azione.valida, true);
  MOCK.reply = `Ok.\n<azione>{"tipo":"prenotazione","giorno":"${next(1)}","ora":"20:30","persone":4,"nome":"Luca","telefono":"333 1234567"}</azione>`;
  r = await ask("Prenoto lunedì");
  assert.equal(r.azione.valida, false);
  assert.match(r.azione.errori.join(), /chiuso/);
});

test("riserva automatica quando l'API è giù", async () => {
  MOCK.mode = "down";
  const r = await ask("Ciao");
  assert.equal(r.status, 200);
  assert.deepEqual([r.fallback, r.motivo], [true, "api"]);
  MOCK.mode = "close";
  const r2 = await ask("Ciao di nuovo");
  assert.deepEqual([r2.fallback, r2.motivo], [true, "api"]);
  MOCK.mode = "ok";
});

test("limite di 20 messaggi per sessione", async () => {
  MOCK.reply = "Va bene.";
  const s = sid();
  for (let i = 1; i <= 20; i++) {
    const r = await ask("messaggio " + i, { s, ip: "10.9.9.9" });
    assert.ok(!r.fallback, "messaggio " + i + " risponde l'AI");
    assert.equal(r.restanti, 20 - i);
  }
  const calls = MOCK.calls;
  const r = await ask("messaggio 21", { s, ip: "10.9.9.9" });
  assert.deepEqual([r.fallback, r.motivo], [true, "limite_sessione"]);
  assert.equal(MOCK.calls, calls, "nessuna chiamata all'API oltre il limite");
});

test("limite per indirizzo IP (sessioni diverse, stesso IP)", async () => {
  const max = (await import("../netlify/lib/cliente-ai.mjs")).default.limiti.max_messaggi_ip;
  let last;
  for (let i = 0; i < max; i++) assert.ok(!(await ask("ciao", { ip: "10.7.7.7" })).fallback);
  last = await ask("ciao", { ip: "10.7.7.7" });
  assert.deepEqual([last.fallback, last.motivo], [true, "troppi_messaggi"]);
});

test("pannello titolare: conversazioni e costo del mese, poi tetto di spesa superato → parole chiave", async () => {
  const get = async () => (await admin(new Request("http://x/api/admin?azione=ai", { headers: { "x-pin": "12345678" } }))).json();
  const a = await get();
  assert.ok(a.conversazioni >= 4 && a.messaggi >= a.conversazioni);
  assert.ok(a.costo_eur > 0);
  assert.equal(a.fallback.api, 2);
  assert.equal(a.tetto_eur, 20);

  // simulo una spesa del mese oltre il tetto
  const { store } = await import("../netlify/lib/menu.mjs");
  const u = await store().get(`ai/uso/${mese}`, { type: "json" });
  await store().setJSON(`ai/uso/${mese}`, { ...u, costo_usd: 25 });
  const calls = MOCK.calls;
  const r = await ask("Ciao");
  assert.deepEqual([r.fallback, r.motivo], [true, "tetto_mensile"]);
  assert.equal(MOCK.calls, calls, "nessuna chiamata all'API oltre il tetto");
  assert.ok((await get()).costo_eur >= 20);
});
