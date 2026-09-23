// ============================================================================
// sync.js — moteur de synchronisation Cults3D → Supabase
// ----------------------------------------------------------------------------
// La sync se fait par *chunks* : chaque appel traite un nombre limité de pages
// GraphQL, met à jour sync_state, puis rend la main. Le front appelle /api/sync
// en boucle jusqu'à `done`. Cela évite de dépasser les limites de durée du
// Worker ET de saturer le rate limit de l'API Cults3D.
// ============================================================================

import {
  PAGE_SIZE,
  graphqlWithBackoff,
  RICH_CREATIONS_QUERY,
  SAFE_CREATIONS_QUERY,
  RICH_SALES_QUERY,
  SAFE_SALES_QUERY,
  RICH_PROFILE_QUERY,
  SAFE_PROFILE_QUERY,
} from "./cults.js";

// Nombre maximal de pages GraphQL traitées par un appel à runSync().
const MAX_PAGES_PER_CHUNK = 4;
// Pause (ms) entre chaque appel GraphQL dans un même chunk.
const PAGE_DELAY_MS = 200;
// Anti-bruit : au moins 30 minutes entre deux snapshots / deux historiques.
const SNAPSHOT_MIN_INTERVAL_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Normalisation
// --------------------------------------------------------------------------
function centsOf(money) {
  if (!money) return 0;
  if (typeof money.cents === "number") return money.cents;
  if (typeof money.value === "number") return Math.round(money.value * 100);
  return 0;
}

function normalizeCreation(raw, user) {
  const id = raw.identifier || raw.url || raw.shortUrl || `${raw.name}`;
  return {
    id,
    user_id: user.id,
    name: raw.name || "",
    url: raw.url || "",
    image_url: raw.illustrationImageUrl || "",
    price_value: centsOf(raw.price) / 100,
    currency: "EUR",
    visibility: raw.visibility || null,
    published_at: raw.publishedAt || null,
    made_with_ai: typeof raw.madeWithAi === "boolean" ? raw.madeWithAi : null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    sales_total_cents: centsOf(raw.totalSalesAmount),
    // champs utilisés pour l'historique
    _views: raw.viewsCount || 0,
    _likes: raw.likesCount || 0,
    _downloads: raw.downloadsCount || 0,
    _sales: centsOf(raw.totalSalesAmount),
    _name: raw.name || "",
    _url: raw.url || "",
    _followers: raw.followersCount ?? null,
    _avatar: raw.imageUrl || null,
    _bio: raw.bio || null,
    _shortUrl: raw.shortUrl || null,
  };
}

function normalizeSale(raw, userId) {
  const creation = raw.creation || {};
  return {
    id: raw.id,
    user_id: userId,
    creation_id: creation.identifier || null,
    creation_name: creation.name || null,
    buyer_nick: (raw.user && raw.user.nick) || null,
    income_cents: centsOf(raw.income),
    currency: "EUR",
    vat_cents: centsOf(raw.vat),
    discount_percentage: raw.discount && raw.discount.percentage != null ? raw.discount.percentage : null,
    creation_views_count: typeof raw.creationViewsCount === "number" ? raw.creationViewsCount : null,
    creation_likes_count: typeof raw.creationLikesCount === "number" ? raw.creationLikesCount : null,
    created_at: raw.createdAt || null,
    payed_out_at: raw.payedOutAt || null,
  };
}

// --------------------------------------------------------------------------
// Requêtes avec repli (schéma riche → schéma sûr)
// --------------------------------------------------------------------------
async function queryWithFallback(ctx, richQuery, safeQuery, variables, fn) {
  try {
    return await graphqlWithBackoff({ ...ctx, query: richQuery, variables });
  } catch (e) {
    if (e.code !== "CULTS_GRAPHQL_ERROR") throw e;
    return await graphqlWithBackoff({ ...ctx, query: safeQuery, variables });
  }
}

// --------------------------------------------------------------------------
// Profil (avatar, abonnés, bio) — appel unique, repli sur profils réduits.
// --------------------------------------------------------------------------
export async function fetchProfile(ctx) {
  try {
    const { data } = await graphqlWithBackoff({ ...ctx, query: RICH_PROFILE_QUERY });
    return data && data.myself && data.myself.user ? data.myself.user : null;
  } catch (e) {
    if (e.code !== "CULTS_GRAPHQL_ERROR") throw e;
  }
  try {
    const { data } = await graphqlWithBackoff({ ...ctx, query: SAFE_PROFILE_QUERY });
    return data && data.myself && data.myself.user ? data.myself.user : null;
  } catch (e) {
    if (e.code !== "CULTS_GRAPHQL_ERROR") throw e;
  }
  return null;
}

// --------------------------------------------------------------------------
// Chunk « créations » : on pagine les créations, on upsert, on trace l'historique.
// --------------------------------------------------------------------------
async function syncCreationsChunk(ctx, store, state) {
  const { user } = ctx;
  const limit = PAGE_SIZE;
  let offset = state.synced_offset;
  let total = state.total;
  let pages = 0;
  let collected = [];
  let rate = null;

  while (pages < MAX_PAGES_PER_CHUNK) {
    const out = await queryWithFallback(
      ctx,
      RICH_CREATIONS_QUERY,
      SAFE_CREATIONS_QUERY,
      { limit, offset },
      (data) => data
    );
    rate = out.rate;
    const batch = out.data && out.data.myself && out.data.myself.creationsBatch;
    if (!batch) break;

    const results = batch.results || [];
    for (const raw of results) collected.push(normalizeCreation(raw, user));
    total = typeof batch.total === "number" ? batch.total : total;

    offset += results.length;
    pages++;

    if (results.length === 0 || offset >= (total ?? offset)) break;
    await sleep(PAGE_DELAY_MS);
  }

  // Sauvegarde des créations (on retire les champs techniques « _ »).
  const rows = collected.map((c) => {
    const row = {};
    for (const [k, v] of Object.entries(c)) {
      if (!k.startsWith("_")) row[k] = v;
    }
    return row;
  });
  let written = 0;
  if (rows.length) {
    await store.upsertCreations(rows);
    written = rows.length;
  }

  // Profil (abonnés / avatar / bio) mis à jour quand présent dans la réponse.
  const profileSource = collected[0];
  if (profileSource) {
    const patchData = {};
    if (profileSource._followers != null) patchData.followers = profileSource._followers;
    if (profileSource._avatar) patchData.avatar_url = profileSource._avatar;
    if (profileSource._bio) patchData.bio = profileSource._bio;
    if (profileSource._shortUrl) patchData.profile_url = profileSource._shortUrl;
    if (Object.keys(patchData).length) await store.patchUser(user.id, patchData);
  }

  // Historique (courbes vues/likes/téléchargements) — antibruit 30 min.
  const due = await store.historyDue(user.id, SNAPSHOT_MIN_INTERVAL_MS);
  if (due && collected.length) {
    await store.insertHistory(
      collected.map((c) => ({
        user_id: user.id,
        creation_id: c.id,
        captured_at: new Date().toISOString(),
        downloads: c._downloads,
        views: c._views,
        likes: c._likes,
        sales_amount_cents: c._sales,
      }))
    );
  }

  const done = total != null && offset >= total;
  await store.updateSyncState(user.id, { synced_offset: offset, total: total ?? null });

  return {
    done,
    stage: "creations",
    offset,
    total,
    written,
    rate: rate,
  };
}

// --------------------------------------------------------------------------
// Chunk « ventes » : delta-sync. Les ventes sont insérées avec
// `ignore-duplicates` ; dès qu'une page entière est déjà connue, on s'arrête
// (les nouvelles ventes apparaissent en tête de liste).
// --------------------------------------------------------------------------
async function syncSalesChunk(ctx, store, state) {
  const { user } = ctx;
  const limit = PAGE_SIZE;
  let offset = state.synced_offset;
  let total = state.total;
  let pages = 0;
  let newSales = 0;
  let fetched = 0;
  let rate = null;
  let reachedEnd = false;

  while (pages < MAX_PAGES_PER_CHUNK) {
    const out = await queryWithFallback(ctx, RICH_SALES_QUERY, SAFE_SALES_QUERY, { limit, offset }, (d) => d);
    rate = out.rate;
    const batch = out.data && out.data.myself && out.data.myself.salesBatch;
    if (!batch) break;

    const results = (batch.results || []).map((s) => normalizeSale(s, user.id));
    total = typeof batch.total === "number" ? batch.total : total;
    fetched += results.length;

    const inserted = await store.insertSales(results);
    newSales += inserted.length;

    // On pagine jusqu'à la fin (le tri par défaut n'est pas documenté) : les
    // doublons sont éliminés par `ignore-duplicates`, donc la passe complète
    // est idempotente.
    const got = results.length;
    offset += got;
    pages++;

    if (got === 0 || (total != null && offset >= total)) {
      reachedEnd = true;
      break;
    }
    await sleep(PAGE_DELAY_MS);
  }

  await store.updateSyncState(user.id, { synced_offset: offset, total: total ?? null });

  return {
    done: reachedEnd,
    stage: "sales",
    offset,
    total,
    newSales,
    fetched,
    rate,
  };
}

// --------------------------------------------------------------------------
// Point d'entrée : un chunk → retourne l'état d'avancement.
// --------------------------------------------------------------------------
export async function runSync(user, store, endpoint) {
  const apiKey = await decryptApiKeyForWorker(user); // injecté par index.js
  const ctx = { nick: user.nick, apiKey, endpoint };

  let state = await store.getSyncState(user.id);
  let runId = null;

  if (!state) {
    // Nouvelle session de synchronisation.
    const profile = await fetchProfile(ctx);
    const run = await store.createSyncRun(user.id);
    runId = run && run.id ? run.id : null;
    await store.createSyncState(user.id, "creations", runId);
    state = await store.getSyncState(user.id);
    // Mettre à jour le profil immédiatement (avatar / followers).
    if (profile) {
      await store.patchUser(user.id, {
        avatar_url: profile.imageUrl || user.avatar_url || null,
        bio: profile.bio || user.bio || null,
        profile_url: profile.shortUrl || user.profile_url || null,
        followers: typeof profile.followersCount === "number" ? profile.followersCount : user.followers || 0,
      });
    }
  } else {
    // Reprise : on utilise le run_id stocké, sinon la synchro « running » la
    // plus récente (compatibilité avec d'anciens états).
    runId = state.run_id ?? null;
    if (runId == null) {
      const running = await store.latestRunningSyncRun(user.id);
      runId = running ? running.id : null;
      if (runId) await store.updateSyncState(user.id, { run_id: runId });
    }
  }

  let progress;
  try {
    if (state.stage === "sales") {
      progress = await syncSalesChunk(ctx, store, state);
      if (progress.done) {
        progress = { ...progress, done: true };
        await finalizeSync(user, store, { newSales: progress.newSales, rate: progress.rate });
      }
    } else {
      progress = await syncCreationsChunk(ctx, store, state);
      if (progress.done) {
        await store.updateSyncState(user.id, { stage: "sales", synced_offset: 0, total: null, run_id: runId });
        // On rend la main : le front rappelle immédiatement /api/sync pour la phase ventes.
        progress = { ...progress, done: false, next: "sales" };
      }
    }
  } catch (e) {
    await store.failSyncRun(runId, String(e.message || e));
    await store.deleteSyncState(user.id);
    throw e;
  }

  return { ...progress, runId };
}

// --------------------------------------------------------------------------
// Finalisation : snapshot global + journal de synchronisation.
// --------------------------------------------------------------------------
async function finalizeSync(user, store, { newSales = 0, rate = null } = {}) {
  const creations = await store.fetchCreationsAll(user.id);
  const sales = await store.fetchSalesAll(user.id);
  const salesCount = sales.length;
  const revenueCents = sales.reduce((s, x) => s + (x.income_cents || 0), 0);

  // Dernière valeur connue de chaque création à partir de son historique.
  const lastHistory = await store.fetchHistoryAll(user.id);
  const latest = {};
  for (const h of lastHistory) {
    latest[h.creation_id] = h; // ordre croissant → écrase avec la plus récente
  }
  const totalViews = Object.values(latest).reduce((s, h) => s + (h.views || 0), 0);
  const totalLikes = Object.values(latest).reduce((s, h) => s + (h.likes || 0), 0);
  const totalDownloads = Object.values(latest).reduce((s, h) => s + (h.downloads || 0), 0);

  const freshUser = (await store.getUserById(user.id)) || user;
  const due = await store.snapshotDue(user.id, SNAPSHOT_MIN_INTERVAL_MS);
  if (due) {
    await store.insertSnapshot({
      user_id: user.id,
      captured_at: new Date().toISOString(),
      followers: freshUser.followers || 0,
      creations_count: creations.length,
      total_views: totalViews,
      total_downloads: totalDownloads,
      total_likes: totalLikes,
      total_revenue_cents: revenueCents,
      total_sales: salesCount,
      raw: null,
    });
  }

  const run = await store.createSyncRun(user.id);
  if (run && run.id) {
    await store.finishSyncRun(run.id, {
      status: "ok",
      creations_synced: creations.length,
      sales_synced: salesCount,
      new_sales: newSales,
      rate_limit_remaining: rate && rate.remaining != null ? Number(rate.remaining) : null,
    });
  }

  return { creations, salesCount, revenueCents };
}

// --------------------------------------------------------------------------
// Ingestion directe : le NAVIGATEUR appelle Cults3D (le Worker est parfois
// bloqué par la protection anti-bot) puis envoie ici les résultats bruts.
// Ce mode remplace la sync Worker → Cults3D quand celui-ci reçoit un HTTP 403.
// --------------------------------------------------------------------------
export async function ingestBatch(user, store, { stage, items, done }) {
  items = Array.isArray(items) ? items : [];

  if (stage === "creations") {
    const normalized = items.map((raw) => normalizeCreation(raw, user));
    const profileSource = normalized[0];
    if (profileSource) {
      const patchData = {};
      if (profileSource._followers != null) patchData.followers = profileSource._followers;
      if (profileSource._avatar) patchData.avatar_url = profileSource._avatar;
      if (profileSource._bio) patchData.bio = profileSource._bio;
      if (profileSource._shortUrl) patchData.profile_url = profileSource._shortUrl;
      if (Object.keys(patchData).length) await store.patchUser(user.id, patchData);
    }

    const rows = normalized.map((c) => {
      const row = {};
      for (const [k, v] of Object.entries(c)) {
        if (!k.startsWith("_")) row[k] = v;
      }
      return row;
    });
    let written = 0;
    if (rows.length) {
      await store.upsertCreations(rows);
      written = rows.length;
    }

    const due = await store.historyDue(user.id, SNAPSHOT_MIN_INTERVAL_MS);
    if (due && normalized.length) {
      await store.insertHistory(
        normalized.map((c) => ({
          user_id: user.id,
          creation_id: c.id,
          captured_at: new Date().toISOString(),
          downloads: c._downloads,
          views: c._views,
          likes: c._likes,
          sales_amount_cents: c._sales,
        }))
      );
    }
    return { ok: true, stage: "creations", written };
  }

  if (stage === "sales") {
    const results = items.map((s) => normalizeSale(s, user.id));
    let insertedCount = 0;
    if (results.length) {
      const inserted = await store.insertSales(results);
      insertedCount = Array.isArray(inserted) ? inserted.length : results.length;
    }
    if (done) {
      await finalizeSync(user, store, { newSales: insertedCount });
    }
    return { ok: true, stage: "sales", newSales: insertedCount, done: !!done };
  }

  return { ok: true, stage };
}

// placeholder remplacé par l'injection de la clé déchiffrée (voir index.js).
let decryptApiKeyForWorker = async () => {
  throw new Error("decryptApiKeyForWorker non injecté");
};

export function setKeyDecryptor(fn) {
  decryptApiKeyForWorker = fn;
}