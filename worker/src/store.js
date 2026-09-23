// ============================================================================
// store.js — accès Supabase (PostgREST REST) depuis le Worker
// ----------------------------------------------------------------------------
// On utilise UNIQUEMENT la clé "service_role" (stockée en secret Worker).
// Elle contourne les RLS : ne jamais l'exposer côté client.
// URL de base :   https://<projet>.supabase.co/rest/v1
// ============================================================================

export function createStore({ url, serviceKey }) {
  const base = url.replace(/\/+$/, "") + "/rest/v1";

  async function raw(method, table, opts = {}) {
    const { body, query = {}, headers = {} } = opts;
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const res = await fetch(`${base}/${table}${qs ? "?" + qs : ""}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Supabase ${method} ${table}: ${res.status} ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }

    const text = await res.text();
    return { json: text ? JSON.parse(text) : null, headers: res.headers };
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------
  const get = (table, query, headers) => raw("GET", table, { query, headers });
  const post = (table, body, headers) => raw("POST", table, { body, headers });
  const patch = (table, query, body) => raw("PATCH", table, { query, body });
  const del = (table, query) => raw("DELETE", table, { query });

  // INSERT ... ON CONFLICT via PostgREST.
  // `on_conflict` est un paramètre de query, `Prefer` un en-tête.
  // `resolution=ignore-duplicates` + `return=representation` renvoie
  // uniquement les lignes réellement insérées (utilisé pour le delta des ventes).
  const upsert = (table, rows, onConflict, resolution = "merge-duplicates") =>
    raw("POST", table, {
      body: Array.isArray(rows) ? rows : [rows],
      query: onConflict ? { on_conflict: onConflict } : {},
      headers: { Prefer: `resolution=${resolution},return=representation` },
    });

  // Compte de lignes via l'en-tête Content-Range (ex: "0-0/123").
  async function count(table, query) {
    const { headers } = await get(table, { ...query, select: "id", limit: 1 }, { Prefer: "count=exact" });
    const cr = headers.get("content-range") || "*/0";
    return Number(cr.split("/")[1] || 0);
  }

  // -------------------------------------------------------------------------
  // Sessions applicatives
  // -------------------------------------------------------------------------
  async function getSession(tokenHash) {
    const r = await get("sessions", { token_hash: `eq.${tokenHash}`, select: "user_id", limit: "1" });
    return r.json && r.json[0] ? r.json[0] : null;
  }

  async function createSession(tokenHash, userId) {
    await post("sessions", [{ token_hash: tokenHash, user_id: userId }]);
  }

  async function touchSession(tokenHash) {
    await patch("sessions", { token_hash: `eq.${tokenHash}` }, { last_used_at: new Date().toISOString() });
  }

  async function clearSessions(userId) {
    await del("sessions", { user_id: `eq.${userId}` });
  }

  // -------------------------------------------------------------------------
  // Utilisateurs
  // -------------------------------------------------------------------------
  const USER_SELECT =
    "id,nick,avatar_url,bio,profile_url,followers,currency,encrypted_api_key,key_prefix,created_at,updated_at";

  async function upsertUser(user) {
    const r = await upsert("users", { ...user, updated_at: new Date().toISOString() }, "nick");
    return r.json ? r.json[0] : null;
  }

  async function getUserByNick(nick) {
    const r = await get("users", { nick: `eq.${nick}`, select: USER_SELECT, limit: "1" });
    return r.json && r.json[0] ? r.json[0] : null;
  }

  async function getUserById(id) {
    const r = await get("users", { id: `eq.${id}`, select: USER_SELECT, limit: "1" });
    return r.json && r.json[0] ? r.json[0] : null;
  }

  async function getUserBySession(tokenHash) {
    const session = await getSession(tokenHash);
    if (!session) return null;
    return getUserById(session.user_id);
  }

  async function patchUser(id, patchData) {
    await patch("users", { id: `eq.${id}` }, { ...patchData, updated_at: new Date().toISOString() });
  }

  async function deleteUser(id) {
    await del("users", { id: `eq.${id}` });
  }

  // -------------------------------------------------------------------------
  // Créations
  // -------------------------------------------------------------------------
  const CREATION_SELECT =
    "id,name,url,image_url,price_value,currency,visibility,published_at,made_with_ai,tags,sales_total_cents,views,likes,downloads,updated_at";

  async function upsertCreations(rows) {
    const r = await upsert("creations", rows.map((c) => ({ ...c, updated_at: new Date().toISOString() })), "id");
    return r.json || [];
  }

  async function fetchCreationsAll(userId) {
    const all = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const r = await get("creations", {
        user_id: `eq.${userId}`,
        select: CREATION_SELECT,
        limit: String(limit),
        offset: String(offset),
      });
      const rows = r.json || [];
      all.push(...rows);
      if (rows.length < limit) break;
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Historique des créations
  // -------------------------------------------------------------------------
  async function insertHistory(rows) {
    if (!rows || !rows.length) return 0;
    await post("creations_history", rows);
    return rows.length;
  }

  // Retourne false si un historique a été capturé il y a moins de minIntervalMs.
  async function historyDue(userId, minIntervalMs) {
    const r = await get("creations_history", {
      user_id: `eq.${userId}`,
      select: "captured_at",
      order: "captured_at.desc",
      limit: "1",
    });
    if (!r.json || !r.json[0]) return true;
    const last = new Date(r.json[0].captured_at).getTime();
    return Date.now() - last >= minIntervalMs;
  }

  // -------------------------------------------------------------------------
  // Ventes
  // -------------------------------------------------------------------------
  const SALE_SELECT =
    "id,user_id,creation_id,creation_name,buyer_nick,income_cents,currency,vat_cents,discount_percentage,creation_views_count,creation_likes_count,created_at,payed_out_at";

  // Insère les ventes inconnues uniquement. Retourne les lignes insérées.
  async function insertSales(rows) {
    if (!rows || !rows.length) return [];
    const r = await upsert("sales", rows, "id", "ignore-duplicates");
    return r.json || [];
  }

  async function countSales(userId) {
    return count("sales", { user_id: `eq.${userId}` });
  }

  async function fetchSalesAll(userId) {
    const all = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const r = await get("sales", {
        user_id: `eq.${userId}`,
        select: SALE_SELECT,
        order: "created_at.asc",
        limit: String(limit),
        offset: String(offset),
      });
      const rows = r.json || [];
      all.push(...rows);
      if (rows.length < limit) break;
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Snapshots du profil
  // -------------------------------------------------------------------------
  const SNAPSHOT_SELECT =
    "captured_at,followers,creations_count,total_views,total_downloads,total_likes,total_revenue_cents,total_sales";

  async function insertSnapshot(row) {
    await post("snapshots", [row]);
  }

  // Retourne false si un snapshot existe depuis moins de minIntervalMs.
  async function snapshotDue(userId, minIntervalMs) {
    const r = await get("snapshots", {
      user_id: `eq.${userId}`,
      select: "captured_at",
      order: "captured_at.desc",
      limit: "1",
    });
    if (!r.json || !r.json[0]) return true;
    const last = new Date(r.json[0].captured_at).getTime();
    return Date.now() - last >= minIntervalMs;
  }

  async function fetchSnapshots(userId) {
    const all = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const r = await get("snapshots", {
        user_id: `eq.${userId}`,
        select: SNAPSHOT_SELECT,
        order: "captured_at.asc",
        limit: String(limit),
        offset: String(offset),
      });
      const rows = r.json || [];
      all.push(...rows);
      if (rows.length < limit) break;
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Historique détaillé (pour les sparklines par création)
  // -------------------------------------------------------------------------
  async function fetchHistoryAll(userId) {
    const all = [];
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      const r = await get("creations_history", {
        user_id: `eq.${userId}`,
        select: "creation_id,captured_at,views,likes,downloads,sales_amount_cents",
        order: "captured_at.asc",
        limit: String(limit),
        offset: String(offset),
      });
      const rows = r.json || [];
      all.push(...rows);
      if (rows.length < limit) break;
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // État / journal de synchronisation
  // -------------------------------------------------------------------------
  async function getSyncState(userId) {
    const r = await get("sync_state", { user_id: `eq.${userId}`, limit: "1" });
    return r.json && r.json[0] ? r.json[0] : null;
  }

  async function createSyncState(userId, stage, runId = null) {
    await post("sync_state", [{ user_id: userId, stage, synced_offset: 0, run_id: runId }]);
  }

  // Dernière synchro encore en cours (reprise si run_id absent dans l'état).
  async function latestRunningSyncRun(userId) {
    const r = await get("sync_runs", {
      user_id: `eq.${userId}`,
      status: "eq.running",
      select: "id,started_at",
      order: "id.desc",
      limit: "1",
    });
    return r.json && r.json[0] ? r.json[0] : null;
  }

  async function updateSyncState(userId, patchData) {
    await patch("sync_state", { user_id: `eq.${userId}` }, { ...patchData, updated_at: new Date().toISOString() });
  }

  async function deleteSyncState(userId) {
    await del("sync_state", { user_id: `eq.${userId}` });
  }

  async function createSyncRun(userId) {
    const r = await post("sync_runs", [{ user_id: userId, status: "running" }]);
    return r.json && r.json[0] ? r.json[0] : null;
  }

  async function finishSyncRun(runId, patchData) {
    if (!runId) return;
    await patch("sync_runs", { id: `eq.${runId}` }, { finished_at: new Date().toISOString(), ...patchData });
  }

  async function failSyncRun(runId, message) {
    if (!runId) return;
    await patch("sync_runs", { id: `eq.${runId}` }, {
      status: "error",
      message,
      finished_at: new Date().toISOString(),
    });
  }

  async function latestSyncRun(userId) {
    const r = await get("sync_runs", {
      user_id: `eq.${userId}`,
      select: "id,started_at,finished_at,status,message,creations_synced,sales_synced,new_sales,rate_limit_remaining",
      order: "finished_at.desc.nullslast,id.desc",
      limit: "1",
    });
    return r.json && r.json[0] ? r.json[0] : null;
  }

  return {
    raw,
    get,
    post,
    patch,
    del,
    upsert,
    count,
    getSession,
    createSession,
    touchSession,
    clearSessions,
    upsertUser,
    getUserByNick,
    getUserById,
    getUserBySession,
    patchUser,
    deleteUser,
    upsertCreations,
    fetchCreationsAll,
    insertHistory,
    historyDue,
    insertSales,
    countSales,
    fetchSalesAll,
    insertSnapshot,
    snapshotDue,
    fetchSnapshots,
    fetchHistoryAll,
    getSyncState,
    createSyncState,
    updateSyncState,
    deleteSyncState,
    createSyncRun,
    finishSyncRun,
    failSyncRun,
    latestSyncRun,
    latestRunningSyncRun,
  };
}