// ============================================================
// 1) PEGA AQUÍ LOS DATOS DE TU PROYECTO DE SUPABASE
// Project Settings → API
// Usa la Publishable key (o anon key antigua). NUNCA service_role.
// ============================================================

const SUPABASE_URL = "https://fxbbmeflpvajsqjoebzy.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5Wc5QdrJpgfvGuS95Oa2VQ_J98ZNKvy";

const PIGEON_SPEED_KMH = 80;
const POLL_MS = 5000;
const PBKDF2_ITERATIONS = 250000;

const sb = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

let currentDelivery = null;
let pollHandle = null;
let tickHandle = null;

const $ = (id) => document.getElementById(id);

const screens = [
  "sendScreen",
  "travelScreen",
  "arrivalScreen",
  "lostScreen",
  "notFoundScreen"
];

function showScreen(id) {
  screens.forEach((screen) => $(screen).classList.toggle("hidden", screen !== id));
}

function normalizeName(value) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Base64 / crypto ----------

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function deriveKey(name, secret, salt) {
  const encoder = new TextEncoder();
  const password = `${normalizeName(name)}\u0000${secret}`;

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMessage(recipient, secret, message) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(recipient, secret, salt);

  const payload = JSON.stringify({
    v: 1,
    message
  });

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(payload)
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt)
  };
}

async function decryptMessage(name, secret, ciphertext, ivB64, saltB64) {
  const decoder = new TextDecoder();
  const salt = base64ToBytes(saltB64);
  const iv = base64ToBytes(ivB64);
  const encrypted = base64ToBytes(ciphertext);
  const key = await deriveKey(name, secret, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );

  return JSON.parse(decoder.decode(decrypted));
}

// ---------- Geocoding / distance ----------

// Esta demo usa Nominatim directamente y hace SOLO búsquedas iniciadas por el usuario.
// Respetamos el máximo de 1 petición/segundo dejando >1 s entre origen y destino.
// Para una web con mucho tráfico, cambia GEOCODER_BASE por un proveedor dedicado
// o usa un proxy/caché propio.
const GEOCODER_BASE = "https://nominatim.openstreetmap.org/search";

async function geocode(place) {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    q: place,
    "accept-language": "es"
  });

  const response = await fetch(`${GEOCODER_BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Error de geocodificación (${response.status})`);
  }

  const data = await response.json();

  if (!data.length) {
    throw new Error(`No encuentro "${place}". Prueba con ciudad y país.`);
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon)
  };
}

function haversineKm(a, b) {
  const R = 6371.0088;
  const rad = (x) => x * Math.PI / 180;

  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Supabase RPC ----------

async function createDelivery({ origin, destination, distanceKm, ciphertext, iv, salt }) {
  const { data, error } = await sb.rpc("create_delivery", {
    p_origin: origin,
    p_destination: destination,
    p_distance_km: distanceKm,
    p_ciphertext: ciphertext,
    p_iv: iv,
    p_salt: salt
  });

  if (error) throw error;
  if (!data?.length) throw new Error("Supabase no devolvió el envío.");

  return data[0];
}

async function fetchDelivery(id) {
  const { data, error } = await sb.rpc("get_delivery", { p_id: id });

  if (error) throw error;
  return data?.[0] ?? null;
}

// ---------- URLs ----------

function messageIdFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get("m");
}

function buildShareUrl(id) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("m", id);
  return url.toString();
}

function goHome() {
  clearInterval(pollHandle);
  clearInterval(tickHandle);

  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  history.pushState({}, "", url);

  currentDelivery = null;
  $("sendForm").reset();
  $("sendError").textContent = "";
  $("unlockForm").reset();
  $("unlockError").textContent = "";
  $("openedBlock").classList.add("hidden");
  $("unlockForm").classList.remove("hidden");

  showScreen("sendScreen");
}

// ---------- UI: enviar ----------

$("sendForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const button = $("sendButton");
  const errorBox = $("sendError");

  const origin = $("origin").value.trim();
  const destination = $("destination").value.trim();
  const recipient = $("recipient").value.trim();
  const message = $("message").value.trim();
  const secret = $("secret").value;

  errorBox.textContent = "";

  if (!origin || !destination || !recipient || !message || secret.length < 4) {
    errorBox.textContent = "Completa todos los campos. La clave debe tener al menos 4 caracteres.";
    return;
  }

  button.disabled = true;
  button.textContent = "Preparando la paloma…";

  try {
    // Dos búsquedas, separadas para respetar el límite del Nominatim público.
    const from = await geocode(origin);
    await sleep(1100);
    const to = await geocode(destination);

    const distanceKm = haversineKm(from, to);

    const encrypted = await encryptMessage(recipient, secret, message);

    const created = await createDelivery({
      origin,
      destination,
      distanceKm,
      ...encrypted
    });

    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("m", created.id);
    history.pushState({}, "", url);

    currentDelivery = await fetchDelivery(created.id);

    if (!currentDelivery) {
      throw new Error("No se ha podido recuperar el envío recién creado.");
    }

    renderDelivery(currentDelivery, true);
    startTracking(created.id);
  } catch (error) {
    console.error(error);
    errorBox.textContent =
      error?.message ||
      "No he podido enviar la paloma. Revisa la configuración de Supabase.";
  } finally {
    button.disabled = false;
    button.textContent = "Enviar paloma";
  }
});

// ---------- UI: tracking ----------

function formatRemaining(ms) {
  let seconds = Math.max(0, Math.ceil(ms / 1000));

  const days = Math.floor(seconds / 86400);
  seconds %= 86400;

  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;

  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  return days ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

function tickCountdown() {
  if (!currentDelivery || currentDelivery.state !== "traveling") return;

  const start = new Date(currentDelivery.start_at).getTime();
  const arrival = new Date(currentDelivery.arrival_at).getTime();
  const now = Date.now();

  const total = Math.max(1, arrival - start);
  const remaining = Math.max(0, arrival - now);
  const progress = Math.min(1, Math.max(0, (now - start) / total));

  $("timer").textContent = formatRemaining(remaining);
  $("pigeon").style.left = `${7 + progress * 86}%`;

  // El servidor es la autoridad del estado. Al llegar a 0,
  // pedimos una actualización inmediata.
  if (remaining <= 0) {
    refreshDelivery(currentDelivery.id).catch(console.error);
  }
}

function renderDelivery(delivery, showShare = false) {
  currentDelivery = delivery;

  if (delivery.state === "lost") {
    showScreen("lostScreen");
    return;
  }

  if (delivery.state === "delivered") {
    showScreen("arrivalScreen");
    return;
  }

  showScreen("travelScreen");

  $("originLabel").textContent = delivery.origin;
  $("destinationLabel").textContent = delivery.destination;
  $("distanceLabel").textContent = `${Math.round(delivery.distance_km)} km`;
  $("statePill").textContent = "En camino";

  const share = buildShareUrl(delivery.id);
  $("shareUrl").textContent = share;
  $("shareBlock").classList.toggle("hidden", !showShare);

  tickCountdown();
}

async function refreshDelivery(id) {
  const delivery = await fetchDelivery(id);

  if (!delivery) {
    showScreen("notFoundScreen");
    clearInterval(pollHandle);
    clearInterval(tickHandle);
    return;
  }

  const oldState = currentDelivery?.state;
  const keepShareVisible = !$('shareBlock').classList.contains('hidden');
  renderDelivery(delivery, keepShareVisible);

  if (delivery.state !== "traveling") {
    clearInterval(pollHandle);
    clearInterval(tickHandle);
  } else if (oldState !== "traveling") {
    tickCountdown();
  }
}

function startTracking(id) {
  clearInterval(pollHandle);
  clearInterval(tickHandle);

  tickHandle = setInterval(tickCountdown, 1000);

  pollHandle = setInterval(() => {
    refreshDelivery(id).catch((error) => {
      console.error("Error actualizando el envío:", error);
    });
  }, POLL_MS);
}

$("copyButton").addEventListener("click", async () => {
  const text = $("shareUrl").textContent;

  try {
    await navigator.clipboard.writeText(text);
    $("copyButton").textContent = "Copiado";
    setTimeout(() => $("copyButton").textContent = "Copiar enlace", 1400);
  } catch {
    prompt("Copia este enlace:", text);
  }
});

// ---------- UI: abrir mensaje ----------

$("unlockForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = $("receiverName").value;
  const secret = $("receiverSecret").value;
  const errorBox = $("unlockError");

  errorBox.textContent = "";

  try {
    const id = messageIdFromUrl();
    const latest = await fetchDelivery(id);

    if (!latest) {
      showScreen("notFoundScreen");
      return;
    }

    if (latest.state === "lost") {
      showScreen("lostScreen");
      return;
    }

    if (latest.state !== "delivered" || !latest.ciphertext) {
      renderDelivery(latest, false);
      startTracking(id);
      return;
    }

    const payload = await decryptMessage(
      name,
      secret,
      latest.ciphertext,
      latest.iv,
      latest.salt
    );

    $("messageContent").textContent = payload.message;
    $("unlockForm").classList.add("hidden");
    $("openedBlock").classList.remove("hidden");
  } catch (error) {
    console.error(error);
    errorBox.textContent = "Nombre o clave incorrectos.";
  }
});

// ---------- Navegación ----------

$("newMessageButton").addEventListener("click", goHome);
$("lostNewButton").addEventListener("click", goHome);
$("notFoundNewButton").addEventListener("click", goHome);

window.addEventListener("popstate", () => location.reload());

// ---------- Arranque ----------

async function boot() {
  if (
    SUPABASE_URL.includes("TU-PROYECTO") ||
    SUPABASE_PUBLISHABLE_KEY.includes("TU-PUBLISHABLE")
  ) {
    $("sendError").textContent =
      "Antes de usar la web, configura SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY en app.js.";
    showScreen("sendScreen");
    return;
  }

  const id = messageIdFromUrl();

  if (!id) {
    showScreen("sendScreen");
    return;
  }

  try {
    const delivery = await fetchDelivery(id);

    if (!delivery) {
      showScreen("notFoundScreen");
      return;
    }

    renderDelivery(delivery, false);

    if (delivery.state === "traveling") {
      startTracking(id);
    }
  } catch (error) {
    console.error(error);
    showScreen("notFoundScreen");
  }
}

boot();
