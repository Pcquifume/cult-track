// ============================================================================
// crypto.js — utilitaires de chiffrement pour le Worker cult-track
// ----------------------------------------------------------------------------
// La clé API Cults3D est chiffrée en AES-256-GCM avant stockage dans Supabase.
// Chaque joueur est stocké au format :  base64url(iv) "." base64url(data)
// ENC_KEY (secret Worker) doit être une chaîne base64 de 32 octets.
// Exemple :  openssl rand -base64 32
// ============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return b64ToBytes(b);
}

async function buildKey(keyB64) {
  return crypto.subtle.importKey(
    "raw",
    b64ToBytes(keyB64),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// Chiffre une chaîne en clair avec ENC_KEY. Retourne "iv.data" (base64url).
export async function encryptSecret(plain, encKeyB64) {
  if (!encKeyB64) throw new Error("ENC_KEY secret manquant");
  const key = await buildKey(encKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return b64url(iv) + "." + b64url(new Uint8Array(cipher));
}

// Déchiffre une valeur produite par encryptSecret().
export async function decryptSecret(payload, encKeyB64) {
  const [ivS, dataS] = String(payload).split(".");
  if (!ivS || !dataS) throw new Error("Payload chiffré invalide");
  const key = await buildKey(encKeyB64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(ivS) },
    key,
    b64urlToBytes(dataS)
  );
  return dec.decode(plain);
}

// --- Jetons de session ------------------------------------------------------

// Génère un jeton aléatoire lisible (base64url, 43 caractères).
export function newToken() {
  const u = crypto.getRandomValues(new Uint8Array(32));
  return b64url(u);
}

// Hash SHA-256 d'un jeton (hex) : seule sa valeur hachée est stockée.
export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}