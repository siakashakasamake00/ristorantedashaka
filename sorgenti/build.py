#!/usr/bin/env python3
"""Genera il sito del ristorante (index.html, cucina.html, tavoli.html, admin.html) da:
   - sorgenti/cliente.json      scheda del cliente: file dati, cameriere, colori, sigle categorie
   - sorgenti/<dati>.json       locale + prodotti (es. da-shaka.json)
   - <cartella_foto>/<nome-del-piatto>.jpg   (facoltative: se manca, il piatto usa un'immagine neutra)
   - sorgenti/*.template.html + sorgenti/rules.txt

Uso:  python3 sorgenti/build.py                  (richiede: pip install pillow)
      python3 sorgenti/build.py altro-cliente.json   (usa un'altra scheda cliente)
      OUT=/percorso/cartella python3 sorgenti/build.py altro-cliente.json   (scrive i file altrove)
"""
import json, re, unicodedata, base64, io, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))          # .../sorgenti
ROOT = os.path.dirname(HERE)                               # cartella del sito
CLI = json.load(open(os.path.join(HERE, sys.argv[1] if len(sys.argv) > 1 else 'cliente.json')))
OUT = os.environ.get('OUT') or ROOT
DATA = json.load(open(os.path.join(HERE, CLI['dati'])))
FOTO = os.path.join(ROOT, CLI.get('cartella_foto', 'foto'))
PREFIX = CLI.get('prefissi_categorie', {})
W = CLI['cameriere']
R = DATA['restaurant']

# colori predefiniti dei modelli (Da Shaka) → colori del cliente
DEFAULT_COLORS = {
    'principale-950': '#062536', 'principale-900': '#0a3550', 'principale-800': '#0f4563', 'principale-700': '#13587a',
    'principale-200': '#b9d7e4', 'principale-100': '#dcebf1', 'principale-50': '#eef6f9',
    'accento': '#ef6f4f', 'accento-600': '#de5a3b', 'accento-700': '#b9442a', 'accento-200': '#ffc9b8', 'accento-50': '#fff1ec',
}
COLORS = {DEFAULT_COLORS[k]: v.lower() for k, v in CLI.get('colori', {}).items() if k in DEFAULT_COLORS and re.fullmatch(r'#[0-9a-fA-F]{6}', v)}

def hex_rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def recolor(s):
    for old, new in COLORS.items():
        s = re.sub(re.escape(old), new, s, flags=re.I)
        # anche le ombre scritte come rgba(r,g,b,…)
        o, n = hex_rgb(old), hex_rgb(new)
        s = s.replace('rgba(%d,%d,%d,' % o, 'rgba(%d,%d,%d,' % n)
    return s

def slug(s):
    s = unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')

# ---------- menu + foto ----------
menu = {"restaurant": R, "categories": []}
imgs, missing, used = {}, [], set()
for c in DATA["categories"]:
    pre = PREFIX.get(c["name"])
    if not pre:  # sigla automatica: prima lettera libera
        for L in slug(c["name"]).upper().replace('-', '') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
            if L not in used: pre = L; break
    used.add(pre)
    items = []
    for i, p in enumerate(c["products"], 1):
        pid = f'{pre}{i:02d}'
        items.append({"id": pid, "name": p["name"], "desc": p.get("description", ""), "price": p["price"],
                      "all": p.get("allergens", []), "veg": bool(p.get("vegetarian")), "av": p.get("available", True) is not False})
        f = next((f'{FOTO}/{slug(p["name"])}.{e}' for e in ('jpg', 'jpeg', 'png', 'webp') if os.path.exists(f'{FOTO}/{slug(p["name"])}.{e}')), None)
        if f:
            im = Image.open(f).convert('RGB')
            s = min(im.size)
            im = im.crop(((im.size[0] - s) // 2, (im.size[1] - s) // 2, (im.size[0] + s) // 2, (im.size[1] + s) // 2))
            if s > 240: im = im.resize((240, 240), Image.LANCZOS)
            buf = io.BytesIO(); im.save(buf, 'WEBP', quality=80, method=6)
            imgs[pid] = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()
        else:
            missing.append(slug(p["name"]))
    menu["categories"].append({"name": c["name"], "items": items})
total = sum(len(c["items"]) for c in menu["categories"])
if 'prodotti_attesi' in CLI: assert total == CLI['prodotti_attesi'], total

# copertina (foto della hero) e logo del locale
cov = os.path.join(HERE, CLI.get('copertina', 'copertina.jpg'))
if os.path.exists(cov):
    im = Image.open(cov).convert('RGB')
    if im.size[0] > 1200: im = im.resize((1200, round(im.size[1] * 1200 / im.size[0])), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'WEBP', quality=72, method=6)
    imgs['_COVER'] = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()
AVATAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>'
AVATAR = AVATAR_SVG
av = os.path.join(HERE, W['foto']) if W.get('foto') else None
if av and os.path.exists(av):
    im = Image.open(av).convert('RGB'); s0 = min(im.size)
    im = im.crop(((im.size[0] - s0) // 2, (im.size[1] - s0) // 2, (im.size[0] + s0) // 2, (im.size[1] + s0) // 2)).resize((160, 160), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'WEBP', quality=82, method=6)
    AVATAR = '<img src="data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode() + '" alt="">'
LOGO = ''
lg = os.path.join(HERE, CLI['logo']) if CLI.get('logo') else None
if lg and os.path.exists(lg): LOGO = open(lg).read().strip()

def js(o): return json.dumps(o, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
def jstr(s): return json.dumps(s, ensure_ascii=False)[1:-1].replace('</', '<\\/')
def h(s): return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

demo = bool(R.get('demo'))
rules = open(f'{HERE}/rules.txt').read().strip()
rules = (rules.replace('__ALLERGENI__', "i dati del menu sono dimostrativi." if demo else "usa i dati del menu.")
              .replace('__TIPO__', CLI.get('tipo_locale', 'ristorante')).replace('__CARATTERE__', W.get('carattere', '')))

KEY = slug(R['name']) or 'ristorante'
COMMON = [  # l'ordine conta: prima i segnaposto più lunghi
    ('__NAME_UP__', h(R['name'].upper())), ('__NAME_JS__', jstr(R['name'])), ('__TAGLINE_JS__', jstr(R.get('tagline', ''))),
    ('__NAME__', h(R['name'])), ('__KEY__', KEY), ('__TABLES__', str(int(R.get('tables_count', 20)))),
    ('__RUOLO_BREVE__', h(W.get('ruolo_breve', 'Cameriere virtuale'))), ('__RUOLO__', h(W.get('ruolo', 'il cameriere virtuale'))),
    ('__CAMERIERE__', h(W['nome'])), ('__AI__', 'true' if W.get('ai', True) else 'false'), ('__TAKEAWAY__', 'true' if R.get('takeaway_on') else 'false'), ('__LOGO_SVG__', LOGO), ('__AVATAR_HTML__', AVATAR),
]
def fill(s, extra=()):
    for a, b in list(extra) + COMMON: s = s.replace(a, b)
    left = sorted(set(re.findall(r'__[A-Z_]{3,}__', s)))
    assert not left, f'segnaposto non sostituiti: {left}'
    return recolor(s)

# ---------- index.html (menu clienti) ----------
tpl = open(f'{HERE}/menu.template.html').read()
content = (tpl.replace('__MENU_JSON__', js(menu)).replace('__IMG_JSON__', js(imgs))
              .replace('__RULES__', fill(rules).replace('</', '<\\/'))
              .replace('__SUGG__', js(W.get('suggerimenti', [])))
              .replace('__SALUTO__', jstr(W.get('saluto', 'Posso consigliarti un piatto o aiutarti con gli allergeni.'))))
content = fill(content)
if os.environ.get('ARTIFACT_OUT'):
    open(os.environ['ARTIFACT_OUT'], 'w').write(content)
cut = content.index('</style>') + len('</style>')
head_part, body_part = content[:cut], content[cut:]
desc = f'Menu digitale di {R["name"]}' + (f', {R.get("tagline","").lower()}' if R.get('tagline') else '') + (f' a {R["city"]}' if R.get('city') else '') + f', con {W["nome"]}, {W.get("ruolo", "il cameriere virtuale")}.'
theme = COLORS.get('#062536', '#062536')
full = ('<!doctype html>\n<html lang="it">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        f'<meta name="theme-color" content="{theme}">\n'
        f'<meta name="description" content="{h(desc)}">\n'
        + head_part + '\n</head>\n<body>' + body_part + '\n</body>\n</html>\n')

os.makedirs(OUT, exist_ok=True)
open(f'{OUT}/index.html', 'w').write(full)

# ---------- cucina, tavoli, pannello ----------
for name in ('cucina', 'tavoli', 'admin'):
    s = open(f'{HERE}/{name}.template.html').read()
    s = fill(s, [('__PREFIXES__', js({c["name"]: c["items"][0]["id"].rstrip('0123456789') for c in menu["categories"] if c["items"]}))])
    open(f'{OUT}/{name}.html', 'w').write(s)

# cartella nuova per un altro cliente: copio anche funzioni e configurazione Netlify
if os.path.realpath(OUT) != os.path.realpath(ROOT):
    import shutil
    shutil.copytree(f'{ROOT}/netlify', f'{OUT}/netlify', dirs_exist_ok=True)
    for f in ('netlify.toml', 'package.json'): shutil.copy(f'{ROOT}/{f}', OUT)

print(f'{R["name"]} · cameriere: {W["nome"]} · prodotti: {total} · foto: {len(imgs)} · senza foto: {len(missing)}')
if missing: print('  senza foto:', ', '.join(missing))
print(f'index.html: {os.path.getsize(OUT + "/index.html")/1e6:.2f} MB  ·  cartella: {OUT}')
