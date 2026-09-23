/* ============================================================================
   cult-track — Application front (vanilla JS + Apache ECharts)
   ----------------------------------------------------------------------------
   Cults3D bloque à la fois les appels venant du Worker Cloudflare (HTTP 403
   anti-bot) et les appels cross-origin du navigateur (pas de CORS). Le front
   passe donc par un RELAIS (relay/server.mjs, Node, hébergé sur Render en
   "mode central") qui appelle Cults3D pour chaque utilisateur avec sa clé
   (Authorization Basic) et renvoie les réponses.
   ============================================================================ */

const CONFIG = {
  WORKER_URL: "https://cultsstat-api.cybermaitrise.workers.dev", // API (stockage/agrégats)
  RELAY_URL: "https://culttrack-relay.onrender.com/graphql",
  RELAY_STATUS_URL: "https://culttrack-relay.onrender.com/status",
  TOKEN_KEY: "culttrack_token",
  NICK_KEY: "culttrack_nick",
  MAX_SYNC_STEPS: 600,
};

const state = {
  token: localStorage.getItem(CONFIG.TOKEN_KEY) || null,
  nick: localStorage.getItem(CONFIG.NICK_KEY) || null,
  apiKey: sessionStorage.getItem("culttrack_apikey") || null,
  data: null,
  syncing: false,
};

const charts = {};

/* ==========================================================================
   Helpers
   ========================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function money(cents, currency = "EUR", compact = false) {
  const v = (cents || 0) / 100;
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 2,
    }).format(v);
  } catch {
    return v.toFixed(2) + " " + currency;
  }
}

function num(n, compact = true) {
  const v = Number(n || 0);
  try {
    return new Intl.NumberFormat("fr-FR", compact ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(v);
  } catch {
    return String(v);
  }
}

function pct(x) {
  return (Number(x || 0) * 100).toLocaleString("fr-FR", { maximumFractionDigits: 3 }) + " %";
}

function fmtDate(iso, short = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("fr-FR", short
    ? { day: "2-digit", month: "short", year: "2-digit" }
    : { day: "2-digit", month: "long", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function timeAgo(iso) {
  if (!iso) return "jamais";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "à l'instant";
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`;
  return `il y a ${Math.floor(diff / 86_400_000)} j`;
}

function monthLabel(m) {
  const [y, mo] = String(m).split("-");
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
}

// Regroupe la série de revenus jour par jour par mois.
function monthlySeries(revenue) {
  const map = new Map();
  for (const r of revenue || []) {
    if (!r || !r.date) continue;
    const m = r.date.slice(0, 7);
    const b = map.get(m) || { m, label: monthLabel(m), cents: 0, count: 0 };
    b.cents += r.cents || 0;
    b.count += r.count || 0;
    map.set(m, b);
  }
  return [...map.values()].sort((a, b) => a.m.localeCompare(b.m));
}

// Croissance du dernier mois vs mois précédent (revenus).
function monthlyGrowth(months) {
  if (!months.length) return null;
  const cur = months[months.length - 1];
  const prev = months[months.length - 2];
  if (!prev) return { label: cur.label, delta: null, cents: cur.cents };
  const delta = prev.cents > 0 ? (cur.cents - prev.cents) / prev.cents : (cur.cents > 0 ? 1 : 0);
  return { label: cur.label, prevLabel: prev.label, delta, cents: cur.cents };
}

function downloadCsv(filename, rows) {
  const csv = rows
    .map((r) =>
      r
        .map((cell) => {
          const s = String(cell == null ? "" : cell);
          return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(";")
    )
    .join("\r\n") + "\r\n";
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ==========================================================================
   Notifications & tendances
   ========================================================================== */
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 320); }, 4200);
}

// Écart entre les deux derniers points d'un historique (dernière synchro vs précédente).
function trendDelta(points, key) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  return Number(last[key]) - Number(prev[key]);
}

function trendHtml(points, key, unit) {
  const delta = trendDelta(points, key);
  if (delta == null) return `<span class="trend flat">—</span>`;
  const up = delta > 0;
  const cls = delta === 0 ? "flat" : up ? "up" : "down";
  const arrow = up ? "▲" : delta < 0 ? "▼" : "•";
  return `<span class="trend ${cls}" title="Depuis la dernière synchronisation">${arrow} ${num(Math.abs(delta))} ${unit}</span>`;
}

/* ==========================================================================
   API
   ========================================================================== */
async function api(path, { method = "GET", body } = {}) {
  const base = (CONFIG.WORKER_URL || "").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Impossible de joindre l'API. Vérifiez CONFIG.WORKER_URL dans pages/assets/app.js.");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Erreur HTTP ${res.status}`);
    err.code = data && data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

function saveSession(token, nick) {
  state.token = token;
  state.nick = nick;
  localStorage.setItem(CONFIG.TOKEN_KEY, token);
  if (nick) localStorage.setItem(CONFIG.NICK_KEY, nick);
}

function clearSession() {
  state.token = null;
  state.apiKey = null;
  state.data = null;
  localStorage.removeItem(CONFIG.TOKEN_KEY);
  sessionStorage.removeItem("culttrack_apikey");
}

/* ==========================================================================
   API Cults3D — via le relais central
   --------------------------------------------------------------------------
   Cults3D bloque le Worker Cloudflare (403) et les appels cross-origin du
   navigateur (CORS). Le front passe par le relais public (Render, Node,
   relay/server.mjs), qui détient votre clé par requête (Authorization Basic),
   puis envoie chaque lot de résultats au Worker pour stockage/agrégation
   via /api/ingest.
   ========================================================================== */
const SYNC_PAGE_SIZE = 50;
const SYNC_PAGE_DELAY_MS = 200;

const Q_VALIDATE = `
query Validate { myself { user { nick } } }
`;

const Q_CREATIONS = `
query FetchCreations($limit: Int!, $offset: Int!) {
  myself {
    user { nick imageUrl shortUrl bio followersCount creationsCount }
    creationsBatch(limit: $limit, offset: $offset) {
      total
      results {
        identifier
        name(locale: EN)
        url(locale: EN)
        illustrationImageUrl
        downloadsCount
        likesCount
        viewsCount(cached: false)
        totalSalesAmount(currency: EUR) { cents }
        price(currency: EUR) { cents }
        publishedAt
        visibility
        madeWithAi
        tags(locale: EN)
      }
    }
  }
}
`;

const Q_SALES = `
query FetchSales($limit: Int!, $offset: Int!) {
  myself {
    salesBatch(limit: $limit, offset: $offset) {
      total
      results {
        id
        createdAt
        payedOutAt
        income(currency: EUR) { cents }
        vat { cents }
        discount { percentage }
        creationViewsCount
        creationLikesCount
        creation { name(locale: EN) identifier }
        user { nick }
      }
    }
  }
}
`;

// Variantes « sûres » (champs récents absents du schéma distant).
const Q_CREATIONS_SAFE = `
query FetchCreations($limit: Int!, $offset: Int!) {
  myself {
    user { nick imageUrl shortUrl bio }
    creationsBatch(limit: $limit, offset: $offset) {
      total
      results {
        identifier
        name(locale: EN)
        url(locale: EN)
        illustrationImageUrl
        downloadsCount
        likesCount
        viewsCount
        totalSalesAmount(currency: EUR) { cents }
        price(currency: EUR) { cents }
        publishedAt
        visibility
        tags(locale: EN)
      }
    }
  }
}
`;

const Q_SALES_SAFE = `
query FetchSales($limit: Int!, $offset: Int!) {
  myself {
    salesBatch(limit: $limit, offset: $offset) {
      total
      results {
        id
        createdAt
        payedOutAt
        income(currency: EUR) { cents }
        creation { name(locale: EN) }
        user { nick }
      }
    }
  }
}
`;

async function cultsFetchPage(richQuery, safeQuery, variables, root) {
  try {
    const data = await cultsFetch(richQuery, variables);
    if (data && data.myself && data.myself[root]) return data.myself;
  } catch (e) {
    if (e.message && e.message.indexOf("Cults3D :") !== 0) throw e; // erreur réseau/blocage → on abandonne
  }
  const data = await cultsFetch(safeQuery, variables);
  return data && data.myself;
}

async function checkRelay() {
  const res = await fetch(CONFIG.RELAY_STATUS_URL, { credentials: "omit" });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) || null;
}

async function cultsFetch(query, variables = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.nick && state.apiKey) {
    headers.Authorization = "Basic " + btoa(state.nick + ":" + state.apiKey);
  }
  const res = await fetch(CONFIG.RELAY_URL, {
    method: "POST",
    credentials: "omit",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  let json;
  try {
    const text = await res.text();
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Relais Cults3D injoignable (HTTP ${res.status}). S'il était en veille (plan gratuit), réessayez dans ~1 min.`
    );
  }

  if (!res.ok) {
    throw new Error(json.error || `Relais Cults3D : HTTP ${res.status}`);
  }
  if (json.errors) {
    throw new Error("Cults3D : " + json.errors.map((e) => e.message).join(" ; "));
  }
  return json.data;
}

const cultsPause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==========================================================================
   Vues
   ========================================================================== */
function renderLogin(msg = null, error = null) {
  destroyCharts();
  $("#app").innerHTML = `
    <div class="login-wrap">
      <div class="card login-card">
        <div class="login-brand">
          <div class="logo-mark">◈</div>
          <h1>cult<span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">track</span></h1>
          <p>Statistiques, courbes et analyses pour vos modèles 3D publiés sur <strong>Cults3D</strong>.</p>
        </div>

        ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ""}
        ${msg ? `<div class="alert alert-success">${esc(msg)}</div>` : ""}

        <form id="login-form" autocomplete="off">
          <div class="field">
            <label for="nick">Votre pseudo Cults3D</label>
            <input class="input" id="nick" name="nick" required placeholder="ex : MonPseudo3D"
                   value="${esc(state.nick || "")}" />
          </div>
          <div class="field">
            <label for="apiKey">Votre clé API secrète</label>
            <input class="input mono" id="apiKey" name="apiKey" type="password" required
                   placeholder="Votre clé API Cults3D" />
          </div>
          <button class="btn btn-primary btn-lg" id="login-btn" type="submit">Se connecter &amp; synchroniser</button>
        </form>

<div class="hint" style="margin-top:16px">
            Cults3D bloque les appels venus du cloud et du navigateur (403/CORS).
            Le site passe par le <strong>relais central</strong> (Render, gratuit) :
            aucune installation chez vous. Sur le plan gratuit, le relais se met en
            veille — le premier appel (connexion ou 1<sup>re</sup> synchro) peut
            donc prendre une minute.
          </div>

          <p class="login-links" style="margin-top:16px">
            🔒 Votre clé voyage chiffrée (HTTPS) navigateur → relais → Cults3D, et est
            conservée chiffrée (AES-256-GCM) dans Supabase.
          </p>
      </div>
    </div>`;

  $("#login-form").addEventListener("submit", onLogin);
  $("#apiKey").focus();
}

async function onLogin(e) {
  e.preventDefault();
  const btn = $("#login-btn");
  const nick = $("#nick").value.trim();
  const apiKey = $("#apiKey").value.trim();

  if (!nick || !apiKey) return;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Vérification de la clé…`;

  state.nick = nick;
  state.apiKey = apiKey;

  try {
    // 1. Le relais doit être joignable : relais local (config) ou relais central.
    const relay = await checkRelay();
    if (!relay || !relay.ok) {
      throw new Error(
        "Relais Cults3D injoignable (" + CONFIG.RELAY_URL + ").\nSur le plan gratuit, le relais se met en veille : réessayez dans ~1 min."
      );
    }

    let realNick;
    if (relay.mode === "local" && relay.nick) {
      if (nick.toLowerCase() !== String(relay.nick).toLowerCase()) {
        throw new Error(
          `Le relais est configuré pour « ${relay.nick} » et vous avez saisi « ${nick} ». Corrigez-le dans relay.config.json.`
        );
      }
      realNick = String(relay.nick);
    } else {
      // Mode central : la clé est vérifiée via la requête de validation.
      let data;
      try {
        data = await cultsFetch(Q_VALIDATE);
      } catch (e) {
        throw new Error("Impossible de valider la clé Cults3D : " + (e.message || "réessayez."));
      }
      realNick = data && data.myself && data.myself.user && data.myself.user.nick;
      if (!realNick) throw new Error("Cults3D n'a pas confirmé votre pseudo.");
    }

    // 2. Enregistrement côté Worker (validation faite → skipValidate).
    const res = await api("/api/configure", {
      method: "POST",
      body: { nick: realNick, apiKey, skipValidate: true },
    });
    sessionStorage.setItem("culttrack_apikey", apiKey);
    saveSession(res.token, res.user.nick);

    $("#app").innerHTML = `<div class="login-wrap"><div class="card login-card" style="text-align:center">
        <span class="spinner" style="width:34px;height:34px;border-width:3.5px"></span>
        <p style="color:var(--muted);margin-top:16px">Compte relié. Première synchronisation…</p>
      </div></div>`;
    await runSync();
    await loadDashboard();
  } catch (err) {
    state.apiKey = null;
    renderLogin(null, err.message);
  }
}

function renderDashboardShell(d) {
  destroyCharts();
  const u = d.user;
  const last = d.lastSync;
  const statusClass = last && last.status === "ok" ? "" : last && last.status === "error" ? "error" : "pending";

  $("#app").innerHTML = `
    <header class="topbar">
      <div class="container topbar-inner">
        <div class="logo"><div class="logo-mark">◈</div>cult<span>track</span></div>
        <div class="topbar-actions">
          <span class="sync-badge"><span class="dot ${statusClass}"></span> Sync : ${esc(timeAgo(last && last.finished_at))}</span>
          <button class="btn btn-primary" id="btn-sync" title="Relancer la synchronisation">⟳ Actualiser</button>
          <button class="btn btn-ghost" id="btn-rekey" title="Changer de clé API">🔑</button>
          <button class="btn btn-ghost" id="btn-logout" title="Déconnexion">⏻</button>
        </div>
      </div>
    </header>

    <main class="container">
      <section class="card profile">
        ${u.avatarUrl
          ? `<img class="avatar" src="${esc(u.avatarUrl)}" alt="Avatar de ${esc(u.nick)}" onerror="this.outerHTML='<div class=\\'avatar-fallback\\'>${esc((u.nick || "?")[0].toUpperCase())}</div>'" />`
          : `<div class="avatar-fallback">${esc((u.nick || "?")[0].toUpperCase())}</div>`}
        <div class="profile-info">
          <h2>${esc(u.nick)} <span class="tag">Cults3D</span></h2>
          ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : ""}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a class="btn" href="${esc(u.profileUrl || "https://cults3d.com/fr/profil/" + encodeURIComponent(u.nick))}" target="_blank" rel="noopener">↗ Voir mon profil</a>
          <button class="btn btn-danger" id="btn-delete" title="Supprimer le compte et toutes les données">Supprimer</button>
        </div>
      </section>

      <div class="kpi-grid" id="kpis"></div>

      <div class="section-title">Revenus &amp; ventes</div>
      <div class="grid-2">
        <div class="card span-2">
          <p class="card-title">Revenus cumulés</p>
          <p class="card-sub">Revenus journaliers et courbe cumulée (depuis le début)</p>
          <div class="chart tall" id="chart-revenue"></div>
        </div>
        <div class="card span-2">
          <p class="card-title">Ventes par jour</p>
          <p class="card-sub">Nombre de ventes enregistrées chaque jour</p>
          <div class="chart" id="chart-sales"></div>
        </div>
        <div class="card span-2">
          <p class="card-title">Revenus par mois</p>
          <p class="card-sub">Total encaissé chaque mois</p>
          <div class="chart tall" id="chart-month"></div>
        </div>
      </div>

      <div class="section-title">Ventes récentes</div>
      <div class="card">
        <div class="table-toolbar">
          <input class="input" id="sales-search" type="search" placeholder="🔍 Rechercher : acheteur, création…" autocomplete="off" />
          <div class="table-btns">
            <button class="btn btn-ghost" id="btn-export-sales2" title="Télécharger toutes les ventes en CSV">⬇ CSV</button>
          </div>
        </div>
        <div class="table-wrap">
          <table id="sales-table">
            <thead>
              <tr>
                <th class="num" data-sort="created_at" title="Trier par date">Date ⇅</th>
                <th>Création</th>
                <th>Acheteur</th>
                <th class="num" data-sort="income_cents" title="Trier par revenu">Revenu ⇅</th>
                <th class="num">TVA</th>
                <th class="num">Remise</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="table-actions" id="sales-actions"></div>
      </div>

      <div class="section-title">Audience &amp; engagement</div>
      <div class="grid-2">
        <div class="card span-2">
          <p class="card-title">Évolution des métriques</p>
          <p class="card-sub">Vues, likes, téléchargements et abonnés — capturés à chaque synchronisation</p>
          <div class="chart tall" id="chart-engagement"></div>
        </div>
        <div class="card">
          <p class="card-title">Top créations par revenus</p>
          <p class="card-sub">Les modèles qui rapportent le plus</p>
          <div class="chart" id="chart-top"></div>
        </div>
        <div class="card">
          <p class="card-title">Répartition gratuit / payant</p>
          <p class="card-sub">Répartition de votre catalogue</p>
          <div class="chart" id="chart-price"></div>
        </div>
      </div>

      <div class="section-title">Vos créations</div>
      <div class="card">
        <div class="table-toolbar">
          <input class="input" id="table-search" type="search" placeholder="🔍 Rechercher : nom, tag, visibilité…" autocomplete="off" />
          <div class="table-btns">
            <button class="btn btn-ghost" id="btn-export-sales" title="Exporter toutes les ventes en CSV">⬇ Ventes CSV</button>
            <button class="btn btn-ghost" id="btn-export-creations" title="Exporter les créations en CSV">⬇ Créations CSV</button>
          </div>
        </div>
        <div class="table-wrap">
          <table id="creations-table">
            <thead>
              <tr>
                <th>Création</th>
                <th>Prix</th>
                <th class="num" data-sort="views" title="Trier par vues">Vues ⇅</th>
                <th class="num" data-sort="likes" title="Trier par likes">Likes ⇅</th>
                <th class="num" data-sort="downloads" title="Trier par téléchargements">Téléch. ⇅</th>
                <th class="num" data-sort="salesCount" title="Trier par ventes">Ventes ⇅</th>
                <th class="num" data-sort="revenueCents" title="Trier par revenus">Revenus ⇅</th>
                <th class="num" title="Évolution depuis la dernière synchronisation">Tendance</th>
                <th>Courbe</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="table-actions" id="table-actions"></div>
      </div>

      <div class="note" style="margin-top:20px">
        💡 <strong>Les courbes se construisent dans le temps</strong> : chaque synchronisation capture un instantané
        de vos stats. Relancez « ⟳ Actualiser » régulièrement (idéalement 1×/jour) pour faire grandir vos graphiques.
        Vente : <strong>${num(d.totals.sales, false)}</strong>, dernières données ${esc(timeAgo(last && last.finished_at))}.
      </div>
    </main>

    <footer class="footer">
      cult-track — données issues de l'API GraphQL de
      <a href="https://cults3d.com/fr/pages/graphql" target="_blank" rel="noopener">Cults3D</a>.
      Dashboard personnel.
    </footer>`;

  $("#btn-sync").addEventListener("click", async () => {
    try {
      await runSync();
      await loadDashboard();
      toast("Synchronisation terminée", "success");
    } catch (err) {
      toast("Synchronisation impossible : " + err.message, "error");
    }
  });
  $("#btn-logout").addEventListener("click", () => {
    clearSession();
    renderLogin("Session fermée. Vous pouvez vous reconnecter.");
  });
  $("#btn-rekey").addEventListener("click", () => {
    clearSession();
    renderLogin("Entrez votre pseudo et une nouvelle clé API.");
  });
  $("#btn-delete").addEventListener("click", async () => {
    const ok = window.confirm(
      "Supprimer définitivement votre compte cult-track ainsi que toutes vos synchronisations (ventes, historiques, snapshots) ?"
    );
    if (!ok) return;
    try {
      await api("/api/account", { method: "DELETE" });
      clearSession();
      renderLogin("Compte supprimé.");
    } catch (err) {
      toast("Erreur : " + err.message, "error");
    }
  });
}

function renderKpis(d) {
  const t = d.totals;
  const months = monthlySeries(d.revenue);
  const best = months.slice().sort((a, b) => b.cents - a.cents)[0];
  const growth = monthlyGrowth(months);
  const items = [
    { label: "Revenus", value: money(t.revenueCents, d.user.currency, true), foot: `${num(t.sales)} vente(s) · ${pct(t.conversionRate)} de conversion` },
    { label: "Panier moyen", value: money(t.sales ? Math.round(t.revenueCents / t.sales) : 0, d.user.currency, true), foot: t.sales ? `${pct(t.conversionRate)} de conversion` : "aucune vente" },
    { label: "Téléchargements", value: num(t.downloads), foot: `${num(t.avgViewsPerCreation)} vues/création en moyenne` },
    { label: "Vues", value: num(t.views), foot: `${num(t.creationsCount)} création(s)` },
    { label: "Likes", value: num(t.likes), foot: `Revenu moyen : ${money(t.avgRevenuePerCreation, d.user.currency, true)}` },
    { label: "Abonnés", value: num(d.user.followers), foot: d.user.bio ? "" : "Profil Cults3D" },
    { label: "Catalogue", value: `${t.freeCount}<span style="color:var(--muted-2)"> / </span>${t.paidCount + t.freeCount}`, foot: "gratuit / total" },
  ];
  if (best) {
    items.push({ label: "Meilleur mois", value: `${esc(best.label)} <span style="color:var(--muted-2)">•</span> ${money(best.cents, d.user.currency, true)}`, foot: `${num(best.count)} vente(s) sur la période` });
  }
  if (growth && growth.delta != null) {
    const up = growth.delta >= 0;
    items.push({
      label: `Croissance · ${esc(growth.label)}`,
      value: `<span style="color:${up ? "var(--pos)" : "var(--neg)"}">${up ? "▲" : "▼"} ${pct(Math.abs(growth.delta))}</span>`,
      foot: `vs ${esc(growth.prevLabel)}`,
    });
  }
  $("#kpis").innerHTML = items
    .map(
      (i) => `
      <div class="card kpi">
        <div class="kpi-label">${esc(i.label)}</div>
        <div class="kpi-value"><span class="accent">${i.value}</span></div>
        <div class="kpi-foot">${esc(i.foot || "")}</div>
      </div>`
    )
    .join("");
}

/* ==========================================================================
   Table des créations (tri, recherche, détail, export CSV)
   ========================================================================== */
const tableUI = { data: [], q: "", sort: "revenueCents", dir: -1, all: false };

function sparkline(points, key = "views") {
  if (!points || points.length < 2) {
    return `<span style="color:var(--muted-2);font-size:12px">—</span>`;
  }
  const vals = points.map((p) => p[key] || 0);
  const w = 90;
  const h = 26;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (vals.length - 1);
  const coords = vals.map((v, i) => [i * step, h - ((v - min) / span) * (h - 4) - 2]);
  const path = coords.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;
  const last = coords[coords.length - 1];
  return `
    <svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#7c5cff" stop-opacity=".45"/><stop offset="1" stop-color="#00d4ff" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#sg)"/>
      <path d="${path}" fill="none" stroke="#00d4ff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4" fill="#7c5cff"/>
    </svg>`;
}

function renderTable(d) {
  tableUI.data = d.creations || [];
  refreshTable(d);
}

function refreshTable(d) {
  d = d || state.data;
  const tbody = $("#creations-table tbody");
  const actions = $("#table-actions");
  if (!tbody) return;

  const q = tableUI.q.trim().toLowerCase();
  const rows = [...tableUI.data]
    .filter((c) => {
      if (!q) return true;
      const hay = [c.name, c.visibility, c.priceCents ? "payant" : "gratuit", ...(c.tags || [])].join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    })
    .sort((a, b) => {
      const ka = a[tableUI.sort];
      const kb = b[tableUI.sort];
      const va = typeof ka === "number" ? ka : 0;
      const vb = typeof kb === "number" ? kb : 0;
      return (va - vb) * tableUI.dir;
    });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty"><strong>${q ? "Aucune correspondance" : "Aucune création"}</strong>
      ${q ? "Aucune création ne correspond à votre recherche." : "Publiez des modèles 3D, puis lancez une synchronisation."}</div></td></tr>`;
    actions.innerHTML = "";
    return;
  }

  const visible = tableUI.all ? rows : rows.slice(0, 25);
  tbody.innerHTML = visible
    .map((c) => {
      const isPaid = c.priceCents > 0;
      return `
      <tr class="cre-row" data-id="${esc(c.id)}" title="Cliquer pour voir l'évolution">
        <td>
          <div class="cre-item">
            ${c.imageUrl
              ? `<img class="cre-thumb" src="${esc(c.imageUrl)}" loading="lazy" alt="" onerror="this.style.display='none'" />`
              : `<div class="cre-thumb cre-thumb-ph">⬡</div>`}
            <div>
              <div class="cre-name">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="cre-link" onclick="event.stopPropagation()">${esc(c.name)}</a>` : esc(c.name)}</div>
              <div class="cre-meta">${esc(fmtDate(c.publishedAt))} · ${esc(c.visibility || "inconnu")}${c.madeWithAi ? ` · <span class="pill pill-ai">IA</span>` : ""}</div>
            </div>
          </div>
        </td>
        <td><span class="pill ${isPaid ? "pill-paid" : "pill-free"}">${isPaid ? esc(money(c.priceCents, c.currency)) : "Gratuit"}</span></td>
        <td class="num">${num(c.views)}</td>
        <td class="num">${num(c.likes)}</td>
        <td class="num">${num(c.downloads)}</td>
        <td class="num">${num(c.salesCount)}</td>
        <td class="num"><strong>${esc(money(c.revenueCents, d.user.currency, true))}</strong></td>
        <td class="num trend-col">${trendHtml(c.spark, "views", "vues")}<br />${trendHtml(c.spark, "downloads", "tél.")}</td>
        <td>${sparkline(c.spark, "downloads")}</td>
      </tr>`;
    })
    .join("");

  actions.innerHTML = `
    <span style="font-size:13px;color:var(--muted)">
      ${visible.length} / ${rows.length} création(s) · triées par ${tableUI.sort === "revenueCents" ? "revenus" : tableUI.sort}
      ${q ? ` · filtre « ${esc(tableUI.q)} »` : ""}
    </span>
    ${rows.length > 25 ? `<button class="btn btn-ghost" id="btn-show-all">${tableUI.all ? "Réduire" : `Afficher les ${rows.length}`}</button>` : ""}`;

  const showAll = $("#btn-show-all");
  if (showAll) showAll.addEventListener("click", () => { tableUI.all = !tableUI.all; refreshTable(); });
}

function bindTableInteractions(d) {
  const search = $("#table-search");
  if (search) search.addEventListener("input", (e) => { tableUI.q = e.target.value; refreshTable(); });

  $$("#creations-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (tableUI.sort === key) tableUI.dir = -tableUI.dir;
      else { tableUI.sort = key; tableUI.dir = -1; }
      refreshTable();
    });
  });

  const tbody = $("#creations-table tbody");
  if (tbody) tbody.addEventListener("click", (e) => {
    if (e.target.closest("a.cre-link")) return;
    const tr = e.target.closest("tr[data-id]");
    if (tr) openCreationDetail(tr.getAttribute("data-id"));
  });

  const expSales = $("#btn-export-sales");
  if (expSales) expSales.addEventListener("click", exportSalesCsv);

  const expCreations = $("#btn-export-creations");
  if (expCreations) expCreations.addEventListener("click", exportCreationsCsv);
}

/* ==========================================================================
   Ventes récentes (tableau, recherche, tri, export)
   ========================================================================== */
const salesUI = { data: [], q: "", sort: "created_at", dir: -1, limit: 50 };
const SALES_SORTABLE = ["created_at", "income_cents"];

async function loadSales() {
  const r = await api("/api/sales");
  const list = (r && r.sales) || [];
  salesUI.data = list.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  salesUI.limit = 50;
  renderSales();
  bindSalesInteractions();
}

function renderSales() {
  const tbody = $("#sales-table tbody");
  const actions = $("#sales-actions");
  if (!tbody) return;

  const q = salesUI.q.trim().toLowerCase();
  const rows = [...salesUI.data]
    .filter((s) => {
      if (!q) return true;
      return `${s.creation_name || ""} ${s.buyer_nick || ""} ${s.creation_id || ""}`.toLowerCase().indexOf(q) !== -1;
    })
    .sort((a, b) => {
      if (salesUI.sort === "created_at") {
        return String(a.created_at || "").localeCompare(String(b.created_at || "")) * salesUI.dir;
      }
      return ((Number(a.income_cents) || 0) - (Number(b.income_cents) || 0)) * salesUI.dir;
    });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty"><strong>${q ? "Aucune vente ne correspond" : "Aucune vente"}</strong>
      ${q ? "Essayez un autre nom d'acheteur ou de création." : "Les ventes apparaissent après une synchronisation."}</div></td></tr>`;
    actions.innerHTML = "";
    return;
  }

  const visible = rows.slice(0, salesUI.limit);
  tbody.innerHTML = visible
    .map((s) => {
      const total = (Number(s.income_cents) || 0) + (Number(s.vat_cents) || 0);
      return `
      <tr class="sale-row" ${s.creation_id ? `data-id="${esc(s.creation_id)}" title="Cliquer pour voir la création"` : ""}>
        <td class="num">${esc(fmtDateTime(s.created_at))}</td>
        <td>${s.creation_id && (tableUI.data || []).some((c) => String(c.id) === String(s.creation_id)) ? `<a class="cre-link">${esc(s.creation_name || s.creation_id)}</a>` : esc(s.creation_name || s.creation_id || "—")}</td>
        <td>${esc(s.buyer_nick || "—")}</td>
        <td class="num"><strong>${esc(money(s.income_cents, s.currency, true))}</strong></td>
        <td class="num">${esc(money(s.vat_cents || 0, s.currency, true))}</td>
        <td class="num">${s.discount_percentage != null && s.discount_percentage > 0 ? `${s.discount_percentage} %` : "—"}</td>
      </tr>`;
    })
    .join("");

  actions.innerHTML = `
    <span style="font-size:13px;color:var(--muted)">
      ${visible.length} / ${rows.length} vente(s)${salesUI.q ? ` · filtre « ${esc(salesUI.q)} »` : ""}
    </span>
    ${rows.length > salesUI.limit ? `<button class="btn btn-ghost" id="btn-more-sales">Afficher plus (${rows.length - salesUI.limit})</button>` : ""}`;

  const more = $("#btn-more-sales");
  if (more) more.addEventListener("click", () => { salesUI.limit += 100; renderSales(); });
}

function bindSalesInteractions() {
  const search = $("#sales-search");
  if (search) search.addEventListener("input", (e) => { salesUI.q = e.target.value; salesUI.limit = 50; renderSales(); });

  $$("#sales-table th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (!SALES_SORTABLE.includes(key)) return;
      if (salesUI.sort === key) salesUI.dir = -salesUI.dir;
      else { salesUI.sort = key; salesUI.dir = -1; }
      renderSales();
    });
  });

  const tbody = $("#sales-table tbody");
  if (tbody) tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openCreationDetail(tr.getAttribute("data-id"));
  });

  const exp = $("#btn-export-sales2");
  if (exp) exp.addEventListener("click", exportSalesCsv);
}

function exportCreationsCsv() {
  const rows = [["Nom", "URL", "Prix", "Vues", "Likes", "Téléchargements", "Ventes", "Revenus", "Visibilité", "Publiée", "Tags"]];
  for (const c of tableUI.data) {
    rows.push([
      c.name,
      c.url,
      c.priceCents > 0 ? (c.priceCents / 100).toFixed(2) + " " + c.currency : "Gratuit",
      c.views,
      c.likes,
      c.downloads,
      c.salesCount,
      ((c.revenueCents || 0) / 100).toFixed(2),
      c.visibility,
      c.publishedAt ? fmtDate(c.publishedAt, false) : "",
      (c.tags || []).join(", "),
    ]);
  }
  downloadCsv("créations.csv", rows);
}

async function exportSalesCsv() {
  try {
    const r = await api("/api/sales");
    const sales = (r && r.sales) || [];
    const rows = [["Date", "Création", "Acheteur", "Revenu", "Devise", "TVA", "Remise"]];
    for (const s of sales) {
      rows.push([
        s.created_at ? fmtDateTime(s.created_at) : "",
        s.creation_name || s.creation_id || "",
        s.buyer_nick || "",
        ((s.income_cents || 0) / 100).toFixed(2),
        s.currency || "EUR",
        ((s.vat_cents || 0) / 100).toFixed(2),
        s.discount_percentage != null ? s.discount_percentage + "%" : "",
      ]);
    }
    downloadCsv("ventes.csv", rows);
  } catch (e) {
    toast("Export impossible : " + e.message, "error");
  }
}

/* ==========================================================================
   Détail d'une création (courbe d'évolution)
   ========================================================================== */
let detailChart = null;
let detailOverlay = null;

async function openCreationDetail(id) {
  const src = (tableUI.data || []).find((c) => String(c.id) === String(id));
  if (!src) return;

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "detail-overlay";
  overlay.innerHTML = `
    <div class="card modal modal-lg">
      <div class="modal-head">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          ${src.imageUrl
            ? `<img class="cre-thumb cre-thumb-lg" src="${esc(src.imageUrl)}" alt="" onerror="this.style.display='none'" />`
            : `<div class="cre-thumb cre-thumb-lg cre-thumb-ph">⬡</div>`}
          <div style="min-width:0">
            <h3 style="word-break:break-word">${esc(src.name)}</h3>
            <div class="cre-meta">
              ${src.url ? `<a class="cre-link" href="${esc(src.url)}" target="_blank" rel="noopener">Voir sur Cults3D ↗</a>` : ""}
              ${src.publishedAt ? ` · publiée le ${esc(fmtDate(src.publishedAt, false))}` : ""}
              ${src.visibility ? ` · <span class="pill ${src.priceCents > 0 ? "pill-paid" : "pill-free"}">${src.priceCents > 0 ? esc(money(src.priceCents, src.currency)) : "Gratuit"}</span>` : ""}
              ${src.madeWithAi ? ` · <span class="pill pill-ai">IA</span>` : ""}
            </div>
          </div>
        </div>
        <button class="btn btn-ghost" id="detail-close" title="Fermer">✕</button>
      </div>

      <div class="kpi-grid kpi-grid-detail">
        <div class="card kpi"><div class="kpi-label">Vues</div><div class="kpi-value"><span class="accent">${num(src.views)}</span></div><div class="kpi-foot">${(Number(src.salesCount) && Number(src.views)) ? "conversion : " + pct((src.salesCount || 0) / src.views) : ""}</div></div>
        <div class="card kpi"><div class="kpi-label">Téléchargements</div><div class="kpi-value"><span class="accent">${num(src.downloads)}</span></div><div class="kpi-foot">&nbsp;</div></div>
        <div class="card kpi"><div class="kpi-label">Likes</div><div class="kpi-value"><span class="accent">${num(src.likes)}</span></div><div class="kpi-foot">&nbsp;</div></div>
        <div class="card kpi"><div class="kpi-label">Ventes</div><div class="kpi-value"><span class="accent">${num(src.salesCount)}</span></div><div class="kpi-foot">${money(src.revenueCents, src.currency, true)}</div></div>
      </div>

      <div id="detail-chart" class="chart tall" style="min-height:280px"></div>

      <div id="detail-tags" class="tags" style="margin-top:14px"></div>

      <div class="note" style="margin-top:14px">💡 Les courbes se construisent avec vos synchronisations successives.</div>
    </div>`;
  document.body.appendChild(overlay);
  detailOverlay = overlay;

  const close = () => { try { if (detailChart) detailChart.dispose(); } catch { /* ignore */ } detailChart = null; overlay.remove(); detailOverlay = null; };
  $("#detail-close", overlay).addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  if ((src.tags || []).length) {
    $("#detail-tags", overlay).innerHTML = (src.tags || []).map((t) => `<span class="pill pill-tag">${esc(t)}</span>`).join(" ");
  }

  try {
    const r = await api("/api/creation/" + encodeURIComponent(src.id));
    const pts = (r && r.points) || [];
    if (pts.length >= 2 && window.echarts) {
      const el = $("#detail-chart", overlay);
      detailChart = window.echarts.init(el, null, { renderer: "canvas" });
      const opt = baseOption();
      const labels = pts.map((p) => fmtDate(p.captured_at));
      opt.xAxis.data = labels;
      opt.legend.data = ["Vues", "Likes", "Téléchargements", "Revenus"];
      opt.yAxis = [
        { type: "value", splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } }, axisLabel: { color: "#8a91ad", formatter: (v) => num(v) } },
        { type: "value", splitLine: { show: false }, axisLabel: { color: "#8a91ad", formatter: (v) => money(v, src.currency, true) } },
      ];
      opt.series = [
        { name: "Vues", type: "line", smooth: true, symbol: "circle", symbolSize: 7, data: pts.map((p) => p.views || 0), lineStyle: { width: 3, color: "#7c5cff" }, itemStyle: { color: "#7c5cff" } },
        { name: "Téléchargements", type: "line", smooth: true, symbol: "circle", symbolSize: 7, data: pts.map((p) => p.downloads || 0), lineStyle: { width: 3, color: "#00d4ff" }, itemStyle: { color: "#00d4ff" } },
        { name: "Likes", type: "line", smooth: true, symbol: "circle", symbolSize: 7, data: pts.map((p) => p.likes || 0), lineStyle: { width: 3, color: "#2bd576" }, itemStyle: { color: "#2bd576" } },
        { name: "Revenus", type: "bar", yAxisIndex: 1, data: pts.map((p) => p.sales_amount_cents || 0), itemStyle: { color: "rgba(124,92,255,.5)", borderRadius: [5, 5, 0, 0] }, barMaxWidth: 22 },
      ];
      detailChart.setOption(opt);
    } else {
      $("#detail-chart", overlay).innerHTML = `<div class="empty"><span><strong>Pas encore assez de points</strong>Relancez la synchronisation plusieurs fois pour construire la courbe.</span></div>`;
    }
  } catch (err) {
    $("#detail-chart", overlay).innerHTML = `<div class="empty"><span><strong>Détail indisponible</strong>${esc(err.message)}</span></div>`;
  }
}

/* ==========================================================================
   Graphiques (Apache ECharts)
   ========================================================================== */
const PALETTE = ["#7c5cff", "#00d4ff", "#2bd576", "#ffb547", "#ff5c7c", "#f56bff"];

function destroyCharts() {
  Object.keys(charts).forEach((k) => {
    try { charts[k].dispose(); } catch { /* ignore */ }
    delete charts[k];
  });
  if (detailChart) { try { detailChart.dispose(); } catch { /* ignore */ } detailChart = null; }
  if (detailOverlay) { try { detailOverlay.remove(); } catch { /* ignore */ } detailOverlay = null; }
}

function makeChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (!window.echarts) {
    el.innerHTML = `<div class="empty"><strong>Graphique indisponible</strong>Bibliothèque ECharts non chargée (CDN).</div>`;
    return null;
  }
  el.innerHTML = "";
  const chart = window.echarts.init(el, null, { renderer: "canvas" });
  charts[id] = chart;
  return chart;
}

function baseOption() {
  return {
    backgroundColor: "transparent",
    color: PALETTE,
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(16,18,34,.96)",
      borderColor: "rgba(255,255,255,.12)",
      textStyle: { color: "#e7eaf6", fontSize: 13 },
      axisPointer: { type: "line", lineStyle: { color: "rgba(124,92,255,.5)" } },
    },
    grid: { left: 66, right: 26, top: 44, bottom: 46 },
    legend: { textStyle: { color: "#8a91ad", fontSize: 12.5 }, top: 6, icon: "roundRect", itemWidth: 14, itemHeight: 8 },
    textStyle: { color: "#8a91ad", fontFamily: "inherit" },
    xAxis: {
      type: "category",
      axisLine: { lineStyle: { color: "rgba(255,255,255,.14)" } },
      axisLabel: { color: "#8a91ad", fontSize: 12 },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } },
      axisLabel: { color: "#8a91ad", fontSize: 12 },
    },
  };
}

function emptyChart(id, title, sub) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="empty"><span><strong>${esc(title)}</strong>${esc(sub)}</span></div>`;
}

function drawCharts(d) {
  destroyCharts();

  /* --- Revenus cumulés (barres journalières + courbe cumulée) ------------- */
  const rev = d.revenue || [];
  if (!rev.length) {
    emptyChart("chart-revenue", "Aucune vente pour l'instant", "La courbe apparaîtra dès votre première vente.");
  } else {
    const dates = rev.map((r) => fmtDate(r.date));
    let acc = 0;
    const cumul = rev.map((r) => (acc += r.cents));
    const daily = rev.map((r) => r.cents);

    const opt = baseOption();
    opt.legend.data = ["Revenus cumulés", "Revenus du jour"];
    opt.xAxis.data = dates;
    opt.yAxis = [
      {
        type: "value",
        splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } },
        axisLabel: { color: "#8a91ad", fontSize: 12, formatter: (v) => money(v, d.user.currency, true) },
      },
      {
        type: "value",
        splitLine: { show: false },
        axisLabel: { color: "#8a91ad", fontSize: 12, formatter: (v) => money(v, d.user.currency, true) },
      },
    ];
    opt.series = [
      {
        name: "Revenus cumulés",
        type: "line",
        yAxisIndex: 0,
        smooth: true,
        symbol: "none",
        data: cumul,
        lineStyle: { width: 3, color: "#00d4ff" },
        areaStyle: {
          color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(124,92,255,.45)" },
            { offset: 1, color: "rgba(0,212,255,0)" },
          ]),
        },
      },
      {
        name: "Revenus du jour",
        type: "bar",
        yAxisIndex: 1,
        data: daily,
        itemStyle: { color: "rgba(124,92,255,.55)", borderRadius: [5, 5, 0, 0] },
        barMaxWidth: 26,
      },
    ];
    const c = makeChart("chart-revenue");
    if (c) c.setOption(opt);
  }

  /* --- Ventes par jour ----------------------------------------------------- */
  const counts = (d.revenue || []).map((r) => r.count);
  if (!counts.length) {
    emptyChart("chart-sales", "Pas encore de ventes", "Le graphique s'alimentera automatiquement.");
  } else {
    const opt = baseOption();
    opt.xAxis.data = (d.revenue || []).map((r) => fmtDate(r.date));
    opt.series = [
      {
        name: "Ventes",
        type: "bar",
        data: counts,
        itemStyle: { color: "#2bd576", borderRadius: [5, 5, 0, 0] },
        barMaxWidth: 26,
      },
    ];
    const c = makeChart("chart-sales");
    if (c) c.setOption(opt);
  }

  /* --- Revenus par mois ---------------------------------------------------- */
  const months = monthlySeries(d.revenue);
  if (!months.length) {
    emptyChart("chart-month", "Aucune vente pour l'instant", "Les barres mensuelles apparaîtront dès vos premières ventes.");
  } else {
    const opt = baseOption();
    opt.grid = { left: 70, right: 26, top: 20, bottom: 34 };
    opt.tooltip.trigger = "axis";
    opt.tooltip.formatter = (ps) => {
      const p = ps[0];
      const item = months[p.dataIndex];
      return `<strong>${esc(item.label)}</strong><br/>Revenus : ${money(item.cents, d.user.currency)}<br/>Ventes : ${item.count}`;
    };
    opt.xAxis.data = months.map((m) => m.label);
    opt.yAxis = {
      type: "value",
      splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } },
      axisLabel: { color: "#8a91ad", fontSize: 12, formatter: (v) => money(v, d.user.currency, true) },
    };
    opt.series = [
      {
        name: "Revenus",
        type: "bar",
        data: months.map((m) => m.cents),
        itemStyle: { color: "#ffb547", borderRadius: [5, 5, 0, 0] },
        barMaxWidth: 34,
        label: {
          show: true,
          position: "top",
          color: "#8a91ad",
          fontSize: 11,
          formatter: (p) => money(p.value, d.user.currency, true),
        },
      },
    ];
    const c = makeChart("chart-month");
    if (c) c.setOption(opt);
  }

  /* --- Engagement multi-séries -------------------------------------------- */
  const eng = d.engagement || [];
  if (eng.length < 2) {
    emptyChart(
      "chart-engagement",
      "Pas encore assez de points",
      eng.length === 1
        ? "Premier instantané enregistré. Relancez une synchronisation plus tard pour construire la courbe."
        : "Chaque synchronisation ajoute un point. Revenez demain pour commencer les courbes."
    );
  } else {
    const opt = baseOption();
    opt.xAxis.data = eng.map((e) => fmtDate(e.date));
    opt.legend.data = ["Vues", "Téléchargements", "Likes", "Abonnés"];
    opt.yAxis = [
      {
        type: "value",
        splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } },
        axisLabel: { color: "#8a91ad", fontSize: 12, formatter: (v) => num(v) },
      },
      {
        type: "value",
        splitLine: { show: false },
        axisLabel: { color: "#8a91ad", fontSize: 12, formatter: (v) => num(v) },
      },
    ];
    const mk = (name, key, axis, color) => ({
      name,
      type: "line",
      yAxisIndex: axis,
      smooth: true,
      symbol: "circle",
      symbolSize: 7,
      data: eng.map((e) => e[key]),
      lineStyle: { width: 3, color },
      itemStyle: { color },
    });
    opt.series = [
      mk("Vues", "views", 0, "#7c5cff"),
      mk("Téléchargements", "downloads", 0, "#00d4ff"),
      mk("Likes", "likes", 0, "#2bd576"),
      mk("Abonnés", "followers", 1, "#ffb547"),
    ];
    const c = makeChart("chart-engagement");
    if (c) c.setOption(opt);
  }

  /* --- Top créations ------------------------------------------------------- */
  const top = (d.topCreations || []).filter((t) => t.revenueCents > 0).slice(0, 8);
  if (!top.length) {
    const c = makeChart("chart-top");
    if (c) {
      const names = (d.topCreations || []).slice(0, 8).map((t) => t.name.slice(0, 26));
      if (!names.length) { emptyChart("chart-top", "Aucune création", "Importez vos modèles."); }
      else {
        c.setOption({
          ...baseOption(),
          grid: { left: 150, right: 40, top: 20, bottom: 30 },
          tooltip: { ...baseOption().tooltip, formatter: (p) => `${esc(p[0].name)}<br/>Vues : ${p[0].value}` },
          xAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } }, axisLabel: { color: "#8a91ad" } },
          yAxis: { type: "category", data: names, axisLabel: { color: "#8a91ad", fontSize: 12 }, axisLine: { lineStyle: { color: "rgba(255,255,255,.14)" } } },
          series: [{ type: "bar", data: (d.topCreations || []).slice(0, 8).map((t) => t.views), itemStyle: { color: "#7c5cff", borderRadius: [0, 5, 5, 0] }, barMaxWidth: 18 }],
        });
      }
    }
  } else {
    const opt = baseOption();
    opt.grid = { left: 160, right: 46, top: 20, bottom: 36 };
    opt.legend = { show: false };
    opt.tooltip.trigger = "axis";
    opt.tooltip.formatter = (ps) => {
      const p = ps[0];
      const item = top[p.dataIndex];
      return `<strong>${esc(item.name)}</strong><br/>Revenus : ${money(item.revenueCents, d.user.currency)}<br/>Ventes : ${item.salesCount}`;
    };
    opt.xAxis = {
      type: "value",
      splitLine: { lineStyle: { color: "rgba(255,255,255,.06)" } },
      axisLabel: { color: "#8a91ad", fontSize: 12, formatter: (v) => money(v, d.user.currency, true) },
    };
    opt.yAxis = {
      type: "category",
      data: top.map((t) => t.name.length > 24 ? t.name.slice(0, 23) + "…" : t.name),
      axisLabel: { color: "#8a91ad", fontSize: 12.5 },
      axisLine: { lineStyle: { color: "rgba(255,255,255,.14)" } },
      inverse: true,
    };
    opt.series = [
      {
        name: "Revenus",
        type: "bar",
        data: top.map((t) => t.revenueCents),
        itemStyle: { color: "#00d4ff", borderRadius: [0, 6, 6, 0] },
        barMaxWidth: 20,
        label: {
          show: true,
          position: "right",
          color: "#8a91ad",
          fontSize: 11.5,
          formatter: (p) => money(p.value, d.user.currency, true),
        },
      },
    ];
    const c = makeChart("chart-top");
    if (c) c.setOption(opt);
  }

  /* --- Donut gratuit / payant --------------------------------------------- */
  const ps = d.priceShare || { free: { count: 0 }, paid: { count: 0 } };
  const opt = baseOption();
  opt.tooltip.trigger = "item";
  opt.legend = { bottom: 6, textStyle: { color: "#8a91ad", fontSize: 12.5 } };
  opt.series = [
    {
      name: "Catalogue",
      type: "pie",
      radius: ["52%", "76%"],
      center: ["50%", "46%"],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: "#0b0d19", borderWidth: 3, borderRadius: 6 },
      label: { show: true, color: "#e7eaf6", fontSize: 13, formatter: "{b}\n{c} ({d}%)" },
      labelLine: { lineStyle: { color: "#5e6480" } },
      data: [
        { name: "Gratuits", value: ps.free.count, itemStyle: { color: "#00d4ff" } },
        { name: "Payants", value: ps.paid.count, itemStyle: { color: "#ffb547" } },
      ],
    },
  ];
  const cPrice = makeChart("chart-price");
  if (cPrice) cPrice.setOption(opt);
}

/* ==========================================================================
   Synchronisation
   ========================================================================== */
function openSyncModal() {
  const el = document.createElement("div");
  el.className = "overlay";
  el.id = "sync-overlay";
  el.innerHTML = `
    <div class="card modal">
      <h3>Synchronisation en cours</h3>
      <p>Récupération de vos données depuis votre navigateur, puis enregistrement via le Worker (l'API Cults3D bloque parfois les serveurs cloud).</p>
      <div class="progress"><div class="progress-bar" id="sync-progress"></div></div>
      <div class="sync-log" id="sync-log">Initialisation…</div>
      <ul class="steps">
        <li id="step-creations" class="active"><span class="step-icon">1</span> Synchronisation des créations</li>
        <li id="step-sales"><span class="step-icon">2</span> Synchronisation des ventes &amp; revenus</li>
        <li id="step-done"><span class="step-icon">3</span> Construction des statistiques</li>
      </ul>
      <div style="display:flex;justify-content:flex-end;margin-top:20px">
        <button class="btn" id="btn-sync-cancel">Annuler</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  return () => el.remove();
}

function updateSyncProgress(p, done) {
  const bar = document.getElementById("sync-progress");
  const log = document.getElementById("sync-log");
  const sC = document.getElementById("step-creations");
  const sS = document.getElementById("step-sales");
  const sD = document.getElementById("step-done");
  if (!bar) return;

  let pctv = 0;
  if (p.stage === "creations") {
    const t = p.total || 50;
    pctv = Math.min(48, ((p.offset || 0) / t) * 48);
    if (log) log.textContent = `Créations : ${p.offset || 0}/${p.total ?? "?"} (page ${Math.ceil((p.offset || 0) / 50) || 1})`;
  } else if (p.stage === "sales") {
    const t = p.total || 50;
    pctv = 48 + Math.min(48, ((p.offset || 0) / t) * 48);
    if (log) log.textContent = `Ventes : ${p.offset || 0}/${p.total ?? "?"} · ${p.newSales || 0} nouvelle(s)`;
  } else if (done) {
    pctv = 100;
  }

  if (p.stage === "creations" || done) {
    sC.classList.add("done"); sC.classList.remove("active");
    if (!done) { sS.classList.add("active"); sS.classList.remove("done"); }
  }
  if (done) {
    sS.classList.add("done"); sS.classList.remove("active");
    sD.classList.add("done");
    if (log) log.textContent = "Terminé.";
  }

  bar.style.width = pctv + "%";
}

async function runSync() {
  if (state.syncing) return;
  if (!state.apiKey) {
    renderLogin("Votre clé API a été effacée — reconnectez-vous.");
    return;
  }
  state.syncing = true;
  const close = openSyncModal();
  const cancelBtn = document.getElementById("btn-sync-cancel");
  let cancelled = false;
  if (cancelBtn) cancelBtn.addEventListener("click", () => { cancelled = true; });

  try {
    // -- Phase 1 : créations -------------------------------------------------
    updateSyncProgress({ stage: "creations" }, false);
    let offset = 0;
    let total = null;
    let pages = 0;
    let profile = null;
    while (pages < CONFIG.MAX_SYNC_STEPS) {
      if (cancelled) throw new Error("Synchronisation annulée.");
      const myself = await cultsFetchPage(Q_CREATIONS, Q_CREATIONS_SAFE, { limit: SYNC_PAGE_SIZE, offset }, "creationsBatch");
      const batch = myself && myself.creationsBatch;
      if (!batch) break;
      if (!profile && myself && myself.user) profile = myself.user;

      const items = batch.results || [];
      total = typeof batch.total === "number" ? batch.total : total;
      await api("/api/ingest", { method: "POST", body: { stage: "creations", items, profile } });
      offset += items.length;
      pages++;
      updateSyncProgress({ stage: "creations", offset, total }, false);
      if (!items.length || (total != null && offset >= total)) break;
      await cultsPause(SYNC_PAGE_DELAY_MS);
    }

    // -- Phase 2 : ventes ----------------------------------------------------
    updateSyncProgress({ stage: "sales" }, false);
    offset = 0;
    total = null;
    pages = 0;
    let newSales = 0;
    while (pages < CONFIG.MAX_SYNC_STEPS) {
      if (cancelled) throw new Error("Synchronisation annulée.");
      const myself = await cultsFetchPage(Q_SALES, Q_SALES_SAFE, { limit: SYNC_PAGE_SIZE, offset }, "salesBatch");
      const batch = myself && myself.salesBatch;
      if (!batch) {
        // plus rien à récupérer : on clôture quand même.
        await api("/api/ingest", { method: "POST", body: { stage: "sales", items: [], done: true } });
        break;
      }

      const items = batch.results || [];
      total = typeof batch.total === "number" ? batch.total : total;
      offset += items.length;
      const endNow = !items.length || (total != null && offset >= total);
      const ing = await api("/api/ingest", {
        method: "POST",
        body: { stage: "sales", items, done: endNow },
      });
      newSales += ing.newSales || 0;
      pages++;
      updateSyncProgress({ stage: "sales", offset, total, newSales }, false);
      if (endNow) break;
      await cultsPause(SYNC_PAGE_DELAY_MS);
    }

    updateSyncProgress({ stage: "done" }, true);
    await cultsPause(450);
  } finally {
    state.syncing = false;
    close();
  }
}

/* ==========================================================================
   Chargement & rendu du dashboard
   ========================================================================== */
async function loadDashboard() {
  const d = await api("/api/dashboard");
  state.data = d;
  renderDashboardShell(d);
  renderKpis(d);
  renderTable(d);
  bindTableInteractions(d);
  drawCharts(d);
  loadSales().catch(() => { /* le tableau des ventes est non bloquant */ });
}

async function boot() {
  if (!state.token) {
    renderLogin();
    return;
  }
  try {
    const me = await api("/api/me");
    if (me && me.user) state.nick = me.user.nick;
    await loadDashboard();
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      renderLogin("Votre session a expiré, reconnectez-vous.");
    } else {
      renderLogin(null, err.message);
    }
  }
}

/* Redimensionnement des graphiques. */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    Object.values(charts).forEach((c) => { try { c.resize(); } catch { /* ignore */ } });
  }, 140);
});

/* Démarrage (l'API ECharts est chargée en defer, comme app.js). */
let booted = false;
function start() {
  if (booted) return;
  booted = true;
  boot();
}
document.addEventListener("DOMContentLoaded", start);
if (document.readyState !== "loading") start();