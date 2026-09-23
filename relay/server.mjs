// ============================================================================
// Relais cult-track (Node.js ≥ 18, aucune dépendance)
// ----------------------------------------------------------------------------
// Utile car Cults3D :
//   - bloque l'appel depuis les Worker Cloudflare (HTTP 403 anti-bot), et
//   - refuse le cross-origin (CORS) pour un fetch direct du navigateur.
// Ce relais expose un petit proxy vers https://cults3d.com/graphql, utilisable
// de deux façons :
//   * local (défaut) : sur http://127.0.0.1:8790, la clé vit dans
//     relay.config.json et n'est jamais envoyée au navigateur ;
//   * central (VPS)  : CULTS_RELAY_HOST=0.0.0.0 avec HTTPS en frontal — chaque
//     utilisateur envoie son pseudo+clé en en-tête Authorization Basic à chaque
//     requête (mode décidé par l'absence de relay.config.json / env).
//
// Démarrage :  node relay/server.mjs   (ou : npm start dans le dossier relay/)
// ============================================================================

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CULTS_ENDPOINT = "https://cults3d.com/graphql";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PORT = Number(process.env.CULTS_RELAY_PORT || 8790);
const HOST = process.env.CULTS_RELAY_HOST || "127.0.0.1";
const MAX_BODY_BYTES = 100 * 1024; // 100 Ko (l'API Cults3D n'accepte pas plus)

// --- Rate limiting simple par IP (token bucket) --------------------------------
const RATE_MAX_REQ = 40; // requêtes par fenêtre
const RATE_WINDOW_MS = 10_000;
const ipBuckets = new Map(); // ip -> { tokens, last }

function clientIp(req) {
  // Derrière Render, on lit l'en-tête de terminaison ; sinon socket.
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "unknown";
}

function rateLimit(ip) {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b) b = { tokens: RATE_MAX_REQ, last: now };
  b.tokens = Math.min(RATE_MAX_REQ, b.tokens + (RATE_MAX_REQ / RATE_WINDOW_MS) * (now - b.last));
  b.last = now;
  if (b.tokens < 1) {
    ipBuckets.set(ip, b);
    return -1; // bloqué
  }
  b.tokens -= 1;
  ipBuckets.set(ip, b);
  return Math.floor(b.tokens);
}

// Ménage mémoire : ne garder que les IPs actives récemment.
const LIMIT_CLEANUP_MS = 60_000;
setInterval(() => {
  if (ipBuckets.size < 1000) return;
  const now = Date.now();
  for (const [ip, b] of ipBuckets) {
    if (now - b.last > LIMIT_CLEANUP_MS) ipBuckets.delete(ip);
  }
}, LIMIT_CLEANUP_MS).unref();

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

function loadConfig() {
  const fp = join(HERE, "relay.config.json");
  if (existsSync(fp)) {
    try {
      const c = JSON.parse(readFileSync(fp, "utf8"));
      return {
        nick: String(c.nick || ""),
        apiKey: String(c.apiKey || ""),
        allowedOrigins: Array.isArray(c.allowedOrigins) ? c.allowedOrigins : ["https://cult-track.pages.dev"],
      };
    } catch (e) {
      console.error("⚠️  relay.config.json illisible :", e.message);
    }
  }
  return {
    nick: process.env.CULTS3D_NICK || "",
    apiKey: process.env.CULTS3D_API_KEY || "",
    allowedOrigins: ["https://cult-track.pages.dev"],
  };
}

const cfg = loadConfig();

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / hors navigateur
  return cfg.allowedOrigins.indexOf(origin) !== -1;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = isOriginAllowed(req);
  return {
    "Access-Control-Allow-Origin": allowed ? origin || "*" : "null",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function send(res, req, status, obj, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(req),
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (!isOriginAllowed(req)) {
    return send(res, req, 403, { error: "Origine non autorisée pour le relais local." });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const url = new URL(req.url, "http://" + HOST);

  if (req.method === "GET" && url.pathname === "/status") {
    return send(res, req, 200, {
      ok: true,
      nick: cfg.nick || null,
      configured: !!(cfg.nick && cfg.apiKey),
      mode: cfg.nick ? "local" : "central", // local = 1 seul compte ; central = clés passées à chaque requête
      port: PORT,
    });
  }

  if (req.method === "POST" && url.pathname === "/graphql") {
    const ip = clientIp(req);
    const remaining = rateLimit(ip);
    if (remaining < 0) {
      return send(
        res,
        req,
        429,
        { error: "Trop de requêtes depuis cette adresse. Réessayez dans quelques secondes." },
        { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1000)) }
      );
    }
    const rateHeaders = { "X-RateLimit-Remaining": String(remaining), "X-RateLimit-Limit": String(RATE_MAX_REQ) };

    let body = "";
    let bytes = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
      body += chunk;
    }
    if (tooLarge) {
      return send(res, req, 413, { error: "Corps de requête trop grand (max 100 Ko)." }, rateHeaders);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return send(res, req, 400, { error: "Corps JSON invalide." });
    }

    // Identifiants : prioritaires ceux de la requête (mode central, un compte
    // par utilisateur) sinon ceux du fichier de config (mode local).
    let creds = null;
    const authHeader = req.headers.authorization || "";
    if (authHeader.indexOf("Basic ") === 0) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
        const i = decoded.indexOf(":");
        if (i > 0) creds = { nick: decoded.slice(0, i), apiKey: decoded.slice(i + 1) };
      } catch {
        /* auth illisible → fallback config */
      }
    }
    const nick = (creds && creds.nick) || cfg.nick;
    const apiKey = (creds && creds.apiKey) || cfg.apiKey;

    if (!nick || !apiKey) {
      return send(res, req, 500, { error: "Aucun identifiant : envoyez un en-tête Authorization Basic (pseudo:clé) ou configurez relay.config.json." });
    }
    try {
      const out = await fetch(CULTS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          Authorization: "Basic " + Buffer.from(nick + ":" + apiKey).toString("base64"),
        },
        body: JSON.stringify({ query: payload.query, variables: payload.variables || {} }),
      });
      const text = await out.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* réponse non JSON */
      }
      const status = out.ok || (json && Array.isArray(json.errors)) ? 200 : out.status;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(req),
        ...SECURITY_HEADERS,
        ...rateHeaders,
        "X-Cults-Nick": nick,
        "X-Cults-Rate-Limit": out.headers.get("x-ratelimit-limit") || "",
        "X-Cults-Rate-Remaining": out.headers.get("x-ratelimit-remaining") || "",
        "X-Cults-Rate-Reset": out.headers.get("x-ratelimit-reset") || "",
      });
      res.end(text);
    } catch (e) {
      send(res, req, 502, { error: "Impossible de joindre Cults3D depuis le relais : " + (e && e.message ? e.message : e) });
    }
    return;
  }

  send(res, req, 404, { error: "Route inconnue — utilisez POST /graphql." });
});

server.listen(PORT, HOST, () => {
  console.log("Relais cult-track prêt : http://" + HOST + ":" + PORT + "/graphql");
  if (!cfg.nick || !cfg.apiKey) {
    console.log("⚠️  Créez relay/relay.config.json (nick + apiKey), puis relancez ce script.");
  } else {
    console.log("Connecté en tant que : " + cfg.nick);
  }
});