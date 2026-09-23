// ============================================================================
// cults.js — client GraphQL de l'API Cults3D
// ----------------------------------------------------------------------------
// Endpoint unique : POST https://cults3d.com/graphql
// Auth           : HTTP Basic  (utilisateur = pseudo Cults, mot de passe = clé API)
// Limitation     : dynamique, lue dans les headers x-ratelimit-*
// Sources documentées : https://cults3d.com/fr/pages/graphql  (gist officiel,
// documentation communautaire cults3d-api-docs).
// ============================================================================

export const CULTS_ENDPOINT = "https://cults3d.com/graphql";
export const PAGE_SIZE = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function basicAuth(nick, apiKey) {
  return "Basic " + btoa(`${nick}:${apiKey}`);
}

// CULTS3D est protégé par Cloudflare : un User-Agent réaliste est nécessaire,
// sinon le `fetch` du Worker (IP data center + UA par défaut) reçoit un 403 HTML.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Appel GraphQL unique + lecture des headers de rate limit.
// Lève une erreur détaillée en cas de réponse d'erreur GraphQL.
// ---------------------------------------------------------------------------
export async function graphql({ nick, apiKey, endpoint, query, variables, operationName }) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Authorization: basicAuth(nick, apiKey),
    },
    body: JSON.stringify({ query, variables, operationName }),
  });

  const rate = {
    limit: res.headers.get("x-ratelimit-limit"),
    remaining: res.headers.get("x-ratelimit-remaining"),
    reset: res.headers.get("x-ratelimit-reset"),
  };

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 160);
    const err = new Error(
      `Réponse non JSON de Cults3D (HTTP ${res.status})${snippet ? " — " + snippet : ""}`
    );
    err.code = "CULTS_NON_JSON";
    err.status = res.status;
    err.rate = rate;
    throw err;
  }

  if (!res.ok && !json.data) {
    const err = new Error(`Cults3D a répondu HTTP ${res.status}`);
    err.code = "CULTS_HTTP_ERROR";
    err.status = res.status;
    throw err;
  }

  if (json.errors) {
    const err = new Error("Cults3D: " + json.errors.map((e) => e.message).join(" ; "));
    err.code = "CULTS_GRAPHQL_ERROR";
    err.errors = json.errors;
    err.rate = rate;
    throw err;
  }

  return { data: json.data, rate };
}

// ---------------------------------------------------------------------------
// Appel avec retries + backoff exponentiel, et pause si le quota restant est bas.
// ---------------------------------------------------------------------------
export async function graphqlWithBackoff(opts, { retries = 4, baseDelay = 900, minRemaining = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await graphql(opts);
      const remaining = out.rate && Number(out.rate.remaining);
      if (!isNaN(remaining) && remaining > 0 && remaining <= minRemaining) {
        await sleep(3500);
      }
      return out;
    } catch (e) {
      if (e.code === "CULTS_GRAPHQL_ERROR") throw e; // erreur de schéma : inutile de rejouer
      if (attempt >= retries) throw e;
      const wait = baseDelay * 2 ** attempt;
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------------------
// Requêtes GraphQL
// ---------------------------------------------------------------------------

// Petit appel de validation : confirme que pseudo + clé fonctionnent.
export const VALIDATE_QUERY = `
query Validate {
  myself {
    user { nick imageUrl shortUrl }
  }
}
`;

// Version minimale, si un champ optionnel du schéma pose problème.
export const MINIMAL_VALIDATE_QUERY = `
query Validate {
  myself {
    user { nick }
  }
}
`;

export const RICH_CREATIONS_QUERY = `
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

// Variante prudentielle : sans les champs les plus récents (followersCount,
// viewsCount(cached), madeWithAi) au cas où le schéma distant ne les expose pas.
export const SAFE_CREATIONS_QUERY = `
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

export const RICH_SALES_QUERY = `
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

export const SAFE_SALES_QUERY = `
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

export const RICH_PROFILE_QUERY = `
query Profile {
  myself {
    user { nick imageUrl shortUrl bio followersCount creationsCount }
  }
}
`;

export const SAFE_PROFILE_QUERY = `
query Profile {
  myself {
    user { nick imageUrl shortUrl bio }
  }
}
`;