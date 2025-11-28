import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import admin from "firebase-admin";
import axios from "axios";

dotenv.config();

// 🔥 Inicializar Firebase Admin
// -------------------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ ERROR: No existe FIREBASE_SERVICE_ACCOUNT en Railway!");
  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error("❌ ERROR al parsear FIREBASE_SERVICE_ACCOUNT:", err.message);
  process.exit(1);
}

if (!serviceAccount.private_key) {
  console.error("❌ ERROR: private_key no existe dentro del JSON de service account");
  console.log("ServiceAccount keys:", Object.keys(serviceAccount));
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    ...serviceAccount,
    privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
  }),
});

console.log("🔥 Firebase Admin inicializado correctamente");


const db = admin.firestore();

// ------------------------------------
// 🔥 WebSocket Server
// ------------------------------------
const port = process.env.PORT || 3001;
const server = http.createServer();
const wss = new WebSocketServer({ server });

// 🔹 Todas las conexiones
const allClients = new Set();

// 🔹 Map: mesaKey → Set(ws)
// mesaKey = `${slug}:${mesaId}`
const mesaGroups = new Map();

// 🔹 Cache local de mesas activas
// mesaKey → { slug, mesaId, saleId, lastUpdatedAt }
let mesasActivas = new Map();

// ------------------------------------
// 🔥 Conexión del cliente
// ------------------------------------
wss.on("connection", (ws) => {
  allClients.add(ws);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // Cliente se une a una mesa
      if (data.type === "join-mesa" && data.slug && data.mesaId) {
        const mesaKey = `${data.slug}:${data.mesaId}`;

        if (!mesaGroups.has(mesaKey)) {
          mesaGroups.set(mesaKey, new Set());
        }
        mesaGroups.get(mesaKey).add(ws);

        ws.mesaKey = mesaKey;
        return;
      }
    } catch (err) {
      console.error("❌ Error parsing message:", err);
    }
  });

  ws.on("close", () => {
    allClients.delete(ws);

    if (ws.mesaKey && mesaGroups.has(ws.mesaKey)) {
      mesaGroups.get(ws.mesaKey).delete(ws);

      if (mesaGroups.get(ws.mesaKey).size === 0) {
        mesaGroups.delete(ws.mesaKey);
      }
    }
  });
});

// ------------------------------------
// 🔥 Cargar mesas activas desde Firestore
// ------------------------------------
async function cargarMesasActivas() {
  const negocios = await db.collection("negocios").get();

  negocios.forEach(async (negocioDoc) => {
    const slug = negocioDoc.id;
    const mesasSnap = await db.collection("negocios").doc(slug).collection("mesas").get();

    mesasSnap.forEach((mesaDoc) => {
      const data = mesaDoc.data();
      const mesaId = mesaDoc.id;

      if (data.saleId) {
        const mesaKey = `${slug}:${mesaId}`;

        mesasActivas.set(mesaKey, {
          slug,
          mesaId,
          saleId: data.saleId,
          lastUpdatedAt: null
        });
      }
    });
  });

  console.log("🔥 Mesas activas cargadas:", mesasActivas.size);
}

// Ejecutar al iniciar
cargarMesasActivas();

// ------------------------------------
// 🔥 Token Fudo (apiKey + apiSecret)
// ------------------------------------
async function getFudoToken(slug) {
  const negocioSnap = await db.collection("negocios").doc(slug).get();
  const negocio = negocioSnap.data();

  const { apiKey, apiSecret } = negocio.fudo;

  const res = await axios.post("https://auth.fu.do/api", {
    apiKey,
    apiSecret
  });

  return res.data.token;
}

// ------------------------------------
// 🔥 Chequear actualizaciones en Fudo
// ------------------------------------
async function checkMesa(mesa) {
  try {
    const token = await getFudoToken(mesa.slug);

    const saleRes = await axios.get(
      `https://api.fu.do/v1alpha1/sales/${mesa.saleId}?include=items`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const sale = saleRes.data.data;

    const updatedAt = sale.attributes.updatedAt;

    // Si es la primera vez → almacenar
    if (!mesa.lastUpdatedAt) {
      mesa.lastUpdatedAt = updatedAt;
      return;
    }

    // Si cambió updatedAt → notificar a los clientes
    if (mesa.lastUpdatedAt !== updatedAt) {
      mesa.lastUpdatedAt = updatedAt;

      const mesaKey = `${mesa.slug}:${mesa.mesaId}`;

      if (mesaGroups.has(mesaKey)) {
        mesaGroups.get(mesaKey).forEach((client) => {
          if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: "venta-actualizada" }));
          }
        });
      }

      console.log(`🔔 Mesa ${mesaKey} actualizada`);
    }

  } catch (err) {
    console.error("❌ Error checking sale:", err?.response?.data || err.message);
  }
}

// ------------------------------------
// 🔁 Polling cada 15 segundos
// ------------------------------------
setInterval(async () => {
  for (const [mesaKey, mesa] of mesasActivas.entries()) {
    await checkMesa(mesa);
  }
}, 15000);


import express from "express";

const app = express();
app.use(express.json());

// El WebSocket server y Express comparten el mismo server http
server.on("request", app);

// Ruta para broadcast desde Fudo webhook
app.post("/broadcast", (req, res) => {
  const { mesaKey, type } = req.body;

  if (!mesaKey || !type) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  console.log("📣 Broadcast WS:", mesaKey, type);

  if (mesaGroups.has(mesaKey)) {
    mesaGroups.get(mesaKey).forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type }));
      }
    });
  }

  return res.json({ ok: true });
});


// 🚀 Iniciar servidor
// ------------------------------------
server.listen(port, () => {
  console.log(`✅ WS Mesas running on port ${port}`);
});
