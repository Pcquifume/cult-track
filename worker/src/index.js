// ============================================================================
// cult-track · Worker Cloudflare — point d'entrée
// ----------------------------------------------------------------------------
// Routes (CORS activé, auth par Bearer pour toutes les routes données sauf /api/configure) :
//   POST /api/configure   {nick, apiKey}  → valide la clé Cults3D, la chiffre,
//                                           l'enregistre, crée une session → {token, user}
//   GET  /api/me                          → résumé du profil + dernière sync
//   POST /api/sync                        → avance la synchronisation d'un chunk
//   GET  /api/dashboard                   → toutes les données des graphiques
//   GET  /api/creation/:id                → historique d'une création
//   DELETE /api/account                   → supprime le compte + données
//   GET  /api/health                      → état du worker
//
// Cron (plan payant) : synchronise automatiquement tous les utilisateurs.
// ============================================================================

import { createStore } from "./store.js";
import { buildDashboard } from "./stats.js";
import { runSync, ingestBatch, setKeyDecryptor } from "./sync.js";
import { VALIDATE_QUERY, MINIMAL_VALIDATE_QUERY, graphqlWithBackoff } from "./cults.js";
import { encryptSecret, decryptSecret, newToken, hashToken } from "./crypto.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...SECURITY, ...extra },
  });
}

function error(message, status = 500, code = "ERROR") {
  return json({ error: message, code }, status);
}

function readBody(req) {
  return req.json().catch(() => null);
}

function bearerToken(req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function maskKey(key) {
  if (!key) return "";
  const k = String(key);
  return k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k.slice(0, 4) + "…";
}

// Au-delà, la session est supprimée et l'utilisateur doit se reconnecter.
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_INGEST_ITEMS = 300;

// ---------------------------------------------------------------------------
// Configuration commune (store + décrypteur de clé API Cults3D)
// ---------------------------------------------------------------------------
function makeEnv(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error("Worker non configuré : secrets SUPABASE_URL / SUPABASE_SERVICE_KEY manquants.");
  }
  const store = createStore({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  });
  const endpoint = env.CULTS_ENDPOINT || "https://cults3d.com/graphql";
  const relayUrl = env.RELAY_URL || "https://culttrack-relay.onrender.com/graphql";
  return { store, endpoint, encKey: env.ENC_KEY || "", relayUrl };
}

// ---------------------------------------------------------------------------
// Routage HTTP
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      const ctx = makeEnv(env);

      if (path === "/api/health") {
        return json({ ok: true, ts: Date.now() });
      }

      if (path === "/api/configure" && request.method === "POST") {
        return await handleConfigure(request, ctx);
      }

      // Routes protégées (Bearer).
      const token = bearerToken(request);
      if (!token) return error("Session requise", 401, "AUTH_REQUIRED");
      const tokenHash = await hashToken(token);
      const session = await ctx.store.getSession(tokenHash);
      if (!session) return error("Session invalide ou expirée", 401, "AUTH_INVALID");
      const user = await ctx.store.getUserById(session.user_id);
      if (!user) return error("Session invalide", 401, "AUTH_INVALID");
      if (session.last_used_at) {
        const ageMs = Date.now() - new Date(session.last_used_at).getTime();
        if (ageMs > SESSION_MAX_AGE_MS) {
          await ctx.store.del("sessions", { token_hash: `eq.${tokenHash}` });
          return error("Session expirée, reconnectez-vous.", 401, "SESSION_EXPIRED");
        }
      }
      await ctx.store.touchSession(tokenHash);
      ctx.user = user;

      if (path === "/api/me" && request.method === "GET") {
        const lastSync = await ctx.store.latestSyncRun(user.id);
        return json({ user: publicUser(user), lastSync, status: "ok" });
      }

      if (path === "/api/sync" && request.method === "POST") {
        setKeyDecryptor(async (u) => {
          if (!ctx.encKey) throw new Error("Worker non configuré : secret ENC_KEY manquant.");
          return decryptSecret(u.encrypted_api_key, ctx.encKey);
        });
        const progress = await runSync(user, ctx.store, ctx.endpoint);
        return json({ status: "ok", ...progress, user: publicUser(user) });
      }

      // Malgré son nom, ce mode est utilisé en premier : le navigateur appelle
      // Cults3D directement (le Worker reçoit un 403 anti-bot) puis envoie ici
      // chaque lot de résultats bruts pour stockage + agrégation.
      if (path === "/api/ingest" && request.method === "POST") {
        const body = await readBody(request);
        if (!body) return error("Corps de requête invalide.", 400, "BAD_INPUT");
        if (Array.isArray(body.items) && body.items.length > MAX_INGEST_ITEMS) {
          return error("Lot de données trop grand.", 413, "PAYLOAD_TOO_LARGE");
        }
        const progress = await ingestBatch(user, ctx.store, body);
        return json({ status: "ok", ...progress });
      }

      if (path === "/api/dashboard" && request.method === "GET") {
        const data = await buildDashboard(ctx.store, user);
        return json(data);
      }

      if (path === "/api/sales" && request.method === "GET") {
        const sales = await ctx.store.fetchSalesAll(user.id);
        return json({
          status: "ok",
          sales: sales.map((s) => ({
            id: s.id,
            created_at: s.created_at,
            payed_out_at: s.payed_out_at,
            creation_id: s.creation_id,
            creation_name: s.creation_name,
            buyer_nick: s.buyer_nick,
            income_cents: s.income_cents,
            currency: s.currency,
            vat_cents: s.vat_cents,
            discount_percentage: s.discount_percentage,
          })),
        });
      }

      const createMatch = path.match(/^\/api\/creation\/([^/]+)$/);
      if (createMatch && request.method === "GET") {
        const id = decodeURIComponent(createMatch[1]);
        const rows = await ctx.store.get("creations_history", {
          user_id: `eq.${user.id}`,
          creation_id: `eq.${id}`,
          select: "captured_at,views,likes,downloads,sales_amount_cents",
          order: "captured_at.asc",
        });
        return json({ id, points: rows.json || [], status: "ok" });
      }

      if (path === "/api/account" && request.method === "DELETE") {
        await ctx.store.deleteUser(user.id);
        return json({ status: "ok" });
      }

      return error("Route inconnue", 404, "NOT_FOUND");
    } catch (e) {
      console.error("cult-track error:", e && e.message, e && e.stack);
      const status = e && e.status ? e.status : 500;
      if (status >= 500 && (!e.code || e.code === "INTERNAL")) {
        return error("Erreur interne. Réessayez.", status, "INTERNAL");
      }
      return error(e && e.message ? e.message : "Erreur interne", status, e && e.code ? e.code : "INTERNAL");
    }
  },

  // --------------------------------------------------------------------------
  // Synchronisation programmée (plan Worker payant). Sans crons activés,
  // l'utilisateur peut toujours relancer une sync depuis le tableau de bord.
  // --------------------------------------------------------------------------
  async scheduled(controller, env) {
    try {
      const ctx = makeEnv(env);
      const users = await ctx.store.get("users", { select: "id,nick,encrypted_api_key" });
      const all = users.json || [];
      setKeyDecryptor(async (u) => decryptSecret(u.encrypted_api_key, ctx.encKey));

      const maxIterationsPerUser = 60;
      for (const u of all) {
        let iterations = 0;
        while (iterations < maxIterationsPerUser) {
          const p = await runSync(u, ctx.store, ctx.endpoint);
          if (p.done) break;
          iterations++;
        }
      }
    } catch (e) {
      console.error("cult-track scheduled error:", e && e.message);
    }
  },
};

// ---------------------------------------------------------------------------
// POST /api/configure — validation OBLIGATOIRE des identifiants.
//
// Cults3D bloque parfois les appels directs du Worker (HTTP 403 anti-bot) ;
// on bascule alors sur le RELAIS central (Render), qui appelle cults3d.com avec
// les identifiants fournis. En aucun cas une paire pseudo/clé n'est enregistrée
// sans avoir été validée auprès de Cults3D — sinon quiconque connaissant un
// pseudo public pourrait écraser la clé d'un compte existant.
// ---------------------------------------------------------------------------
async function validateKey(ctx, nick, apiKey) {
  // 1) Appel direct Worker → Cults3D.
  try {
    const out = await graphqlWithBackoff(
      { nick, apiKey, endpoint: ctx.endpoint, query: VALIDATE_QUERY },
      { retries: 2, baseDelay: 400 }
    );
    const me = out.data && out.data.myself && out.data.myself.user;
    if (me && me.nick) return { me };
  } catch (e) {
    if (e.code === "CULTS_GRAPHQL_ERROR") {
      // Champ de schéma en cause → réessai avec la requête minimale.
      try {
        const out2 = await graphqlWithBackoff(
          { nick, apiKey, endpoint: ctx.endpoint, query: MINIMAL_VALIDATE_QUERY },
          { retries: 1, baseDelay: 400 }
        );
        const me2 = out2.data && out2.data.myself && out2.data.myself.user;
        if (me2 && me2.nick) return { me: me2 };
      } catch (e2) {
        if (e2.code === "CULTS_GRAPHQL_ERROR") throw e2;
      }
    }
    const blocked = e.status === 403 || e.status === 401 || e.code === "CULTS_NON_JSON";
    if (!blocked) throw e;
  }

  // 2) Repli : validation via le relais central (aucun identifiant n'est
  // transmis au relais sans être présents ici).
  let res;
  try {
    res = await fetch(ctx.relayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "cult-track-worker/1.0",
        Authorization: "Basic " + btoa(`${nick}:${apiKey}`),
      },
      body: JSON.stringify({ query: VALIDATE_QUERY, variables: {} }),
    });
  } catch {
    const err = new Error("Le relais central est injoignable.");
    err.code = "CULTS_VALIDATION_UNAVAILABLE";
    throw err;
  }

  let text = "";
  try { text = await res.text(); } catch { /* ignore */ }
  let json = null;
  try { json = JSON.parse(text); } catch { /* réponse non JSON */ }

  if (json && Array.isArray(json.errors)) {
    const err = new Error(json.errors.map((x) => x.message).join(" ; "));
    err.code = "CULTS_GRAPHQL_ERROR";
    throw err;
  }
  if (!res.ok) {
    const err = new Error("HTTP " + res.status);
    const code = res.status === 401 || res.status === 403 ? "CULTS_AUTH_FAILED" : "CULTS_VALIDATION_UNAVAILABLE";
    err.status = res.status;
    err.code = code;
    throw err;
  }
  const me = json && json.data && json.data.myself && json.data.myself.user;
  if (me && me.nick) return { me };
  const err = new Error("Cults3D n'a pas confirmé le pseudo via le relais.");
  err.code = "CULTS_VALIDATION_UNAVAILABLE";
  throw err;
}

async function handleConfigure(request, ctx) {
  const body = await readBody(request);
  const nick = body && typeof body.nick === "string" ? body.nick.trim() : "";
  const apiKey = body && typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  if (!nick || !apiKey) {
    return error("Pseudo (nick) et clé API requis.", 400, "BAD_INPUT");
  }

  // Validation auprès de Cults3D (direct, sinon relais). Jamais court-circuitée.
  let me;
  try {
    const out = await validateKey(ctx, nick, apiKey);
    me = out.me;
  } catch (e) {
    if (e.code === "CULTS_GRAPHQL_ERROR") {
      return error("Le schéma Cults3D a rejeté la requête : " + e.message, 502, "CULTS_GRAPHQL_ERROR");
    }
    if (e.code === "CULTS_AUTH_FAILED") {
      return error(
        "Clé API Cults3D invalide ou expirée. Recréez une clé sur https://cults3d.com/en/api/keys.",
        401,
        "CULTS_AUTH_FAILED"
      );
    }
    if (e.code === "CULTS_VALIDATION_UNAVAILABLE") {
      return error(
        "Cults3D bloque temporairement les appels et le relais est injoignable. Réessayez dans ~1 minute.",
        503,
        "CULTS_VALIDATION_UNAVAILABLE"
      );
    }
    throw e;
  }
  if (!me || !me.nick) {
    return error("Réponse inattendue de Cults3D.", 502, "CULTS_UNEXPECTED");
  }

  // 2. Chiffrement + enregistrement (nick réel = celui renvoyé par l'API).
  const realNick = me.nick;
  const encrypted = await encryptSecret(apiKey, ctx.encKey);

  const upserted = await ctx.store.upsertUser({
    nick: realNick,
    encrypted_api_key: encrypted,
    key_prefix: maskKey(apiKey),
    avatar_url: me.imageUrl || null,
    profile_url: me.shortUrl || null,
  });

  const userId = upserted ? upserted.id : null;
  if (!userId) {
    const existing = await ctx.store.getUserByNick(realNick);
    if (!existing) return error("Impossible d'enregistrer le compte.", 500, "STORE");
    await ctx.store.patchUser(existing.id, {
      encrypted_api_key: encrypted,
      key_prefix: maskKey(apiKey),
      avatar_url: me.imageUrl || existing.avatar_url,
      profile_url: me.shortUrl || existing.profile_url,
    });
  }

  // 3. Nouvelle session (on invalide les anciennes).
  const token = newToken();
  const userIdFinal = userId || (await ctx.store.getUserByNick(realNick)).id;
  await ctx.store.clearSessions(userIdFinal);
  await ctx.store.createSession(await hashToken(token), userIdFinal);

  return json({
    status: "ok",
    token,
    user: {
      nick: realNick,
      avatarUrl: me.imageUrl || null,
      profileUrl: me.shortUrl || null,
      keyHint: maskKey(apiKey),
    },
  });
}

function publicUser(u) {
  return {
    id: u.id,
    nick: u.nick,
    avatarUrl: u.avatar_url,
    profileUrl: u.profile_url,
    bio: u.bio,
    followers: u.followers,
    currency: u.currency,
    keyHint: u.key_prefix,
  };
}