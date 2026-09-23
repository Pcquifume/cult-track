// ============================================================================
// stats.js — agrégation des statistiques pour le tableau de bord
// ----------------------------------------------------------------------------
// Tous les calculs (revenus par jour, courbes d'engagement, classement des
// créations, répartition gratuit/payant…) sont faits côté Worker à partir des
// données Supabase. Le front reçoit un JSON prêt à afficher.
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(iso) {
  if (!iso) return "1970-01-01";
  // Normalise à la date locale du serveur, sans fuseau.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "1970-01-01";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseTags(t) {
  if (Array.isArray(t)) return t;
  if (typeof t === "string") {
    try {
      return JSON.parse(t);
    } catch {
      return [];
    }
  }
  return [];
}

export async function buildDashboard(store, user) {
  const [creations, sales, snapshots, history] = await Promise.all([
    store.fetchCreationsAll(user.id),
    store.fetchSalesAll(user.id),
    store.fetchSnapshots(user.id),
    store.fetchHistoryAll(user.id),
  ]);

  // ----- Totaux ------------------------------------------------------------
  const hasPrice = (c) => (Number(c.price_value) || 0) > 0;
  const paid = creations.filter(hasPrice);
  const free = creations.filter((c) => !hasPrice(c));

  // Dernière valeur connue par création (via l'historique).
  const latest = {};
  const sparkByCreation = {};
  for (const h of history) {
    latest[h.creation_id] = h;
    (sparkByCreation[h.creation_id] = sparkByCreation[h.creation_id] || []).push(h);
  }

  const revenueCents = sales.reduce((s, x) => s + (x.income_cents || 0), 0);
  const totalViews = Object.values(latest).reduce((s, h) => s + (h.views || 0), 0);
  const totalLikes = Object.values(latest).reduce((s, h) => s + (h.likes || 0), 0);
  const totalDownloads = Object.values(latest).reduce((s, h) => s + (h.downloads || 0), 0);

  // ----- Séries jour par jour (revenus) -------------------------------------
  const byDay = new Map();
  for (const sale of sales) {
    if (!sale.created_at) continue;
    const key = dayKey(sale.created_at);
    const b = byDay.get(key) || { date: key, cents: 0, count: 0 };
    b.cents += sale.income_cents || 0;
    b.count += 1;
    byDay.set(key, b);
  }
  const revenue = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ----- Engagement (courbes globales à partir des snapshots) ---------------
  const engagement = snapshots.map((s) => ({
    date: dayKey(s.captured_at),
    views: s.total_views || 0,
    likes: s.total_likes || 0,
    downloads: s.total_downloads || 0,
    followers: s.followers || 0,
    revenueCents: s.total_revenue_cents || 0,
  }));

  // ----- Classement des créations -------------------------------------------
  const revenueByCreation = new Map();
  const salesCountByCreation = new Map();
  for (const sale of sales) {
    const k = sale.creation_id || sale.creation_name || "";
    if (!k) continue;
    revenueByCreation.set(k, (revenueByCreation.get(k) || 0) + (sale.income_cents || 0));
    salesCountByCreation.set(k, (salesCountByCreation.get(k) || 0) + 1);
  }

  const creationsOut = creations.map((c) => {
    const spark = (sparkByCreation[c.id] || []).map((h) => ({
      date: dayKey(h.captured_at),
      views: h.views || 0,
      likes: h.likes || 0,
      downloads: h.downloads || 0,
    }));
    return {
      id: c.id,
      name: c.name || "Sans titre",
      url: c.url || "",
      imageUrl: c.image_url || "",
      priceCents: Math.round((c.price_value || 0) * 100),
      currency: c.currency || "EUR",
      visibility: c.visibility || null,
      publishedAt: c.published_at || null,
      views: (latest[c.id] && latest[c.id].views) || 0,
      likes: (latest[c.id] && latest[c.id].likes) || 0,
      downloads: (latest[c.id] && latest[c.id].downloads) || 0,
      revenueCents: revenueByCreation.get(c.id) || 0,
      salesCount: salesCountByCreation.get(c.id) || 0,
      tags: parseTags(c.tags),
      spark,
    };
  });

  const byRevenue = [...creationsOut].sort((a, b) => b.revenueCents - a.revenueCents);

  // ----- Répartition gratuit / payant ----------------------------------------
  const freeRevenue = creationsOut
    .filter((c) => c.priceCents <= 0)
    .reduce((s, c) => s + c.revenueCents, 0);
  const paidRevenue = creationsOut
    .filter((c) => c.priceCents > 0)
    .reduce((s, c) => s + c.revenueCents, 0);

  const lastSync = await store.latestSyncRun(user.id);

  return {
    user: {
      nick: user.nick,
      avatarUrl: user.avatar_url || null,
      profileUrl: user.profile_url || null,
      bio: user.bio || null,
      followers: user.followers || 0,
      creationsCount: creations.length,
      currency: user.currency || "EUR",
    },
    totals: {
      views: totalViews,
      likes: totalLikes,
      downloads: totalDownloads,
      revenueCents,
      sales: sales.length,
      freeCount: free.length,
      paidCount: paid.length,
      creationsCount: creations.length,
      avgRevenuePerCreation: creations.length ? Math.round(revenueCents / creations.length) : 0,
      avgViewsPerCreation: creations.length ? Math.round(totalViews / creations.length) : 0,
      conversionRate: totalViews ? sales.length / totalViews : 0,
    },
    revenue,
    engagement,
    priceShare: {
      free: { count: free.length, revenueCents: freeRevenue },
      paid: { count: paid.length, revenueCents: paidRevenue },
    },
    topCreations: byRevenue.slice(0, 12),
    creations: creationsOut,
    lastSync,
    status: "ok",
  };
}