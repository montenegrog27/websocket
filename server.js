import "dotenv/config";
import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import whatsapp from "whatsapp-web.js";
import { db } from "./firebaseAdmin.js";

const { Client, LocalAuth } = whatsapp;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.set("trust proxy", true);

/* ===============================
   HELPERS
================================ */
function safeClientId(input) {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/* ===============================
   AUTH SIMPLE
================================ */
app.use((req, res, next) => {
  // vistas visuales sin auth
  if (
    req.path === "/api/whatsapp/qrcode-view" ||
    req.path === "/api/whatsapp/send-view" ||
    req.path === "/api/whatsapp/send" ||
    req.path === "/api/whatsapp/qrcode" ||        // 👈 ESTE FALTABA
    req.path === "/api/whatsapp/status-view" ||
    req.path === "/api/whatsapp/selector-view" ||  
    req.path === "/api/whatsapp/status"
  ) {
    return next();
  }

  if (req.headers.authorization !== `Bearer ${process.env.WHATSAPP_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

/* ===============================
   SESSION STORE
================================ */
const sessions = new Map();

const STATUS = {
  INIT: "init",
  QR: "qr",
  READY: "ready",
  ERROR: "error",
};

/* ===============================
   FIREBASE LOOKUP
================================ */
async function getPhoneBySlugBranch(slug, branchId) {
  const ref = db
    .collection("negocios")
    .doc(slug)
    .collection("branches")
    .doc(branchId);

  const snap = await ref.get();
  if (!snap.exists) return null;

  return snap.data()?.whatsapp?.phone || null;
}

/* ===============================
   RESET SESSION
================================ */
async function resetSession(key) {
  const client = sessions.get(key);
  if (!client) return;

  try {
    await client.destroy();
  } catch {}

  sessions.delete(key);
}

/* ===============================
   GET OR CREATE SESSION
================================ */
async function getSession(slug, branchId) {
  const key = safeClientId(`${slug}_${branchId}`);
  if (sessions.has(key)) return sessions.get(key);

  const phone = await getPhoneBySlugBranch(slug, branchId);
  if (!phone) throw new Error("WhatsApp no configurado");

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: key }),
puppeteer: {
  headless: false, // para ver si abre el navegador
  args: ["--no-sandbox"],
},


  });

  client.__status = STATUS.INIT;
  client.__lastQr = null;
client.__initializing = false; // 👈 NUEVO
client.__initialized = false;  // 👈 NUEVO
  client.on("qr", (qr) => {
    console.log("📸 QR generado");
    client.__status = STATUS.QR;
    client.__lastQr = qr;
  });

  client.on("ready", () => {
    console.log("✅ WhatsApp conectado");
    client.__status = STATUS.READY;
    client.__lastQr = null;
  });

  client.on("disconnected", () => {
    console.warn("🔌 WhatsApp desconectado");
    sessions.delete(key);
  });

  sessions.set(key, client);
  return client;
}


/* ===============================
   RESTORE SESSIONS (BOOT)
================================ */
async function restoreSessions() {
  console.log("♻️ Restaurando sesiones WhatsApp...");

  const negociosSnap = await db.collection("negocios").get();

  for (const negocio of negociosSnap.docs) {
    const slug = negocio.id;

    const branchesSnap = await negocio.ref
      .collection("branches")
      .where("whatsapp.phone", "!=", null)
      .get();

    for (const branch of branchesSnap.docs) {
      const branchId = branch.id;
      try {
        await getSession(slug, branchId);
        console.log(`✅ ${slug} / ${branchId}`);
      } catch (e) {
        console.warn(`⚠️ ${slug} / ${branchId}: ${e.message}`);
      }
    }
  }
}

/* ===============================
   STATUS
================================ */
app.get("/api/whatsapp/status", async (req, res) => {
  const { slug, branchId } = req.query;
  const key = safeClientId(`${slug}_${branchId}`);
  const client = sessions.get(key);

  // ❌ No hay sesión
  if (!client) {
    return res.json({
      status: "offline",
      needsQr: true,
    });
  }

  try {
    const state = await client.getState();

    // 🟢 Conectado
    if (state === "CONNECTED") {
      return res.json({
        status: "connected",
        needsQr: false,
      });
    }

    // 📱 Requiere QR
    if (state === "UNPAIRED" || state === "DISCONNECTED") {
      return res.json({
        status: state.toLowerCase(),
        needsQr: true,
      });
    }

    // ⏳ Inicializando
    return res.json({
      status: state.toLowerCase(),
      needsQr: false,
    });

  } catch (e) {
    // 💀 Cliente roto
    await resetSession(key);
    return res.json({
      status: "offline",
      needsQr: true,
    });
  }
});



app.get("/api/whatsapp/selector-view", async (req, res) => {
  const negociosSnap = await db.collection("negocios").get();

  const options = [];

  for (const negocio of negociosSnap.docs) {
    const slug = negocio.id;

    const branchesSnap = await negocio.ref
      .collection("branches")
      .where("whatsapp.phone", "!=", null)
      .get();

    for (const branch of branchesSnap.docs) {
      options.push({
        slug,
        branchId: branch.id,
        name:
          branch.data()?.nombre ||
          branch.data()?.whatsapp?.nombre ||
          branch.id,
      });
    }
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Selector WhatsApp</title>
  <style>
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f172a;
      font-family: system-ui, sans-serif;
      color: #e5e7eb;
    }
    .card {
      background: #020617;
      padding: 32px;
      border-radius: 16px;
      width: 420px;
      box-shadow: 0 20px 40px rgba(0,0,0,.5);
    }
    h2 {
      margin-top: 0;
      text-align: center;
    }
    select, button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      border-radius: 8px;
      border: none;
      font-size: 14px;
    }
    select {
      background: #020617;
      color: #e5e7eb;
      border: 1px solid #1e293b;
    }
    button {
      background: #22c55e;
      color: #022c22;
      font-weight: bold;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <h2>📱 WhatsApp · Elegir sucursal</h2>

    <select id="selector">
      <option value="">Seleccionar…</option>
      ${options
        .map(
          (o) =>
            `<option value="${o.slug}|${o.branchId}">
              ${o.slug} / ${o.name}
            </option>`
        )
        .join("")}
    </select>

    <button onclick="go()">Abrir sesión</button>
  </div>

<script>
function go() {
  const value = document.getElementById("selector").value;
  if (!value) return;

  const [slug, branchId] = value.split("|");

  window.location.href =
    "/api/whatsapp/status-view?slug=" +
    encodeURIComponent(slug) +
    "&branchId=" +
    encodeURIComponent(branchId);
}
</script>
</body>
</html>
  `);
});


app.get("/api/whatsapp/status-view", async (req, res) => {
  const { slug, branchId } = req.query;

  const statusApi = `/api/whatsapp/status?slug=${slug}&branchId=${branchId}`;
  const qrView = `/api/whatsapp/qrcode-view?slug=${slug}&branchId=${branchId}`;
  const sendView = `/api/whatsapp/send-view?slug=${slug}&branchId=${branchId}`;

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>WhatsApp Status</title>
  <style>
    body {
      margin: 0;
      height: 100vh;
      background: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, sans-serif;
      color: #e5e7eb;
    }
    .card {
      background: #020617;
      padding: 32px;
      border-radius: 16px;
      width: 420px;
      box-shadow: 0 20px 40px rgba(0,0,0,.5);
      text-align: center;
    }
    .status {
      font-size: 18px;
      margin: 16px 0;
    }
    .connected { color: #22c55e; }
    .waiting { color: #eab308; }
    .offline { color: #ef4444; }

    button {
      width: 100%;
      margin-top: 12px;
      padding: 14px;
      border-radius: 10px;
      border: none;
      font-weight: bold;
      font-size: 15px;
      cursor: pointer;
    }
    .qr { background: #2563eb; color: white; }
    .send { background: #22c55e; color: #022c22; }
    .disabled {
      opacity: .4;
      cursor: not-allowed;
    }
    small {
      opacity: .5;
    }
  </style>
</head>
<body>

<div class="card">
  <h2>${slug} / ${branchId}</h2>

  <div id="status" class="status">Cargando estado…</div>

  <button id="qrBtn" class="qr" style="display:none"
    onclick="location.href='${qrView}'">
    📱 Escanear QR
  </button>

  <button id="sendBtn" class="send" style="display:none"
    onclick="location.href='${sendView}'">
    ✉️ Probar envío
  </button>

  <small>Estado en tiempo real</small>
</div>

<script>
async function refresh() {
  const res = await fetch("${statusApi}");
  const data = await res.json();

  const statusEl = document.getElementById("status");
  const qrBtn = document.getElementById("qrBtn");
  const sendBtn = document.getElementById("sendBtn");

  qrBtn.style.display = "none";
  sendBtn.style.display = "none";

  if (data.status === "connected") {
    statusEl.textContent = "✅ WhatsApp conectado";
    statusEl.className = "status connected";
    sendBtn.style.display = "block";
    return;
  }

  if (data.needsQr) {
    statusEl.textContent = "📱 Requiere escanear QR";
    statusEl.className = "status waiting";
    qrBtn.style.display = "block";
    return;
  }

  statusEl.textContent = "⏳ Inicializando WhatsApp…";
  statusEl.className = "status waiting";
}

refresh();
setInterval(refresh, 5000);
</script>

</body>
</html>
  `);
});


/* ===============================
   QR JSON
================================ */
app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug, branchId } = req.query;
  const key = safeClientId(`${slug}_${branchId}`);

  const client = await getSession(slug, branchId);

  // 🟢 Ya conectado
  if (client.__status === STATUS.READY) {
    return res.json({ connected: true });
  }

  // 🚀 Iniciar SOLO una vez
  if (!client.__initialized && !client.__initializing) {
    client.__initializing = true;

    client.initialize()
      .then(() => {
        client.__initialized = true;
        client.__initializing = false;
      })
      .catch(err => {
        console.error("❌ Init error", err.message);
        client.__initializing = false;
        client.__initialized = false;
        sessions.delete(key);
      });
  }

  // 📸 QR disponible
  if (client.__lastQr) {
    const img = await qrcode.toDataURL(client.__lastQr);
    return res.json({ qr: img });
  }

  return res.json({ waiting: true });
});





/* ===============================
   QR VIEW (UI)
================================ */
app.get("/api/whatsapp/qrcode-view", async (req, res) => {
  const { slug, branchId } = req.query;

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>WhatsApp</title>
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e5e7eb;font-family:system-ui}
.card{background:#020617;padding:32px;border-radius:16px;width:380px;text-align:center}
img{width:280px;background:#fff;padding:12px;border-radius:12px;margin-top:16px}
</style>
</head>
<body>
<div class="card">
<h2>${slug} / ${branchId}</h2>
<div id="status">⏳ Inicializando WhatsApp…</div>
<div id="content"></div>
</div>
<script>
async function refresh(){
  const statusRes = await fetch("/api/whatsapp/status?slug=${slug}&branchId=${branchId}");
  const status = await statusRes.json();

  const st = document.getElementById("status");
  const c = document.getElementById("content");

  if (status.status === "connected") {
    st.innerHTML = "✅ WhatsApp conectado";
    c.innerHTML = "<p>Podés cerrar esta ventana</p>";
    return;
  }

  st.innerHTML = "📱 Escaneá el QR";

  // 🔁 SIEMPRE pedir QR cuando no está conectado
  const qrRes = await fetch("/api/whatsapp/qrcode?slug=${slug}&branchId=${branchId}");
  const qr = await qrRes.json();

  if (qr.qr) {
    c.innerHTML = '<img src="' + qr.qr + '" />';
  }
}

refresh();
setInterval(refresh, 5000);
</script>

</body>
</html>
`);
});

/* ===============================
   SEND VIEW
================================ */
app.get("/api/whatsapp/send-view", async (req, res) => {
  const { slug, branchId } = req.query;

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>Enviar WhatsApp</title>
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e5e7eb;font-family:system-ui}
.card{background:#020617;padding:32px;border-radius:16px;width:420px}
input,textarea,button{width:100%;margin-top:12px;padding:12px;border-radius:8px}
button{background:#22c55e;font-weight:bold}
</style>
</head>
<body>
<div class="card">
<h2>${slug} / ${branchId}</h2>
<input id="phone" placeholder="5493794123456"/>
<textarea id="message" placeholder="Mensaje de prueba"></textarea>
<button onclick="send()">Enviar</button>
<div id="status"></div>
</div>
<script>
async function send(){
  const res=await fetch("/api/whatsapp/send",{method:"POST",
  headers:{
    "Content-Type":"application/json",
    "Authorization":"Bearer ${process.env.WHATSAPP_TOKEN}"
  },
  body:JSON.stringify({
    slug:"${slug}",
    branchId:"${branchId}",
    phone:phone.value,
    message:message.value
  })});
  const d=await res.json();
  status.textContent=d.ok?"✅ Enviado":"❌ "+d.error;
}
</script>
</body>
</html>
`);
});

/* ===============================
   SEND MESSAGE
================================ */
app.post("/api/whatsapp/send", async (req, res) => {
  const { slug, branchId, phone, message } = req.body;

  try {
    const key = safeClientId(`${slug}_${branchId}`);
    const client = sessions.get(key);

    // ❌ No hay sesión
    if (!client) {
      return res.status(503).json({
        error: "WhatsApp offline",
        needsQr: true,
      });
    }

    let state;
    try {
      state = await client.getState();
    } catch {
      await resetSession(key);
      return res.status(503).json({
        error: "WhatsApp desconectado",
        needsQr: true,
      });
    }

    // ❌ No conectado
    if (state !== "CONNECTED") {
      return res.status(503).json({
        error: "WhatsApp no listo",
        state,
        needsQr: true,
      });
    }

    await client.sendMessage(`${phone}@c.us`, message);

    res.json({ ok: true });

  } catch (e) {
    console.error("❌ SEND ERROR", e);
    res.status(500).json({
      error: e?.message || "send_failed",
    });
  }
});


/* ===============================
   LOGOUT
================================ */
app.post("/api/whatsapp/logout", async (req, res) => {
  const { slug, branchId } = req.body;
  const key = safeClientId(`${slug}_${branchId}`);
  await resetSession(key);
  res.json({ ok: true });
});

/* ===============================
   SHUTDOWN
================================ */
process.on("SIGINT", async () => {
  for (const c of sessions.values()) {
    try { await c.destroy(); } catch {}
  }
  process.exit(0);
});

/* ===============================
   START
================================ */
app.listen(port, async () => {
  console.log(`🚀 WhatsApp Server on ${port}`);
});
