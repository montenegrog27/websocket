import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ===============================
// MAP DE SESIONES (slug -> client)
// ===============================
const sessions = new Map();

/* ===============================
   LOGOUT WHATSAPP
================================ */
app.post("/api/whatsapp/logout", async (req, res) => {
  const { slug } = req.body;
  const client = sessions.get(slug);

  if (!client) {
    return res.status(400).json({ error: "Sesión no encontrada." });
  }
try {
  if (client) {
    try { await client.logout(); } catch {}
    try { await client.destroy(); } catch {}
    sessions.delete(slug);
  }
  return res.json({ ok: true });
} catch (e) {
  return res.status(500).json({ error: "Error cerrando sesión." });
}

});

/* ===============================
   OBTENER QR / INICIAR SESIÓN
================================ */
app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug requerido" });

  console.log(`🧪 [${slug}] QR solicitado`);

  if (sessions.has(slug)) {
    const existing = sessions.get(slug);
    if (existing.__isReady) {
      return res.json({ connected: true });
    }
    try {
      await existing.destroy();
    } catch {}
    sessions.delete(slug);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: slug }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
  });

  client.__isReady = false;
  sessions.set(slug, client);

  let responded = false;
  const reply = (fn) => {
    if (responded) return;
    responded = true;
    fn();
  };

  const timeout = setTimeout(() => {
    console.warn(`⏱️ [${slug}] Timeout esperando QR`);
    reply(() =>
      res.status(504).json({ error: "Timeout generando QR" }),
    );
  }, 20000);

  client.once("qr", async (qr) => {
    clearTimeout(timeout);
    console.log(`📸 [${slug}] QR generado`);
    const qrImage = await qrcode.toDataURL(qr);
    reply(() => res.json({ qr: qrImage }));
  });

  client.once("ready", () => {
    console.log(`✅ [${slug}] WhatsApp READY`);
    client.__isReady = true;
  });

  client.once("auth_failure", (msg) => {
    console.error(`❌ [${slug}] Auth failure`, msg);
  });

  client.once("disconnected", (reason) => {
    console.warn(`🔌 [${slug}] Desconectado`, reason);
    sessions.delete(slug);
  });

client.initialize().catch((err) => {
  clearTimeout(timeout);
  console.error(`❌ [${slug}] Error inicializando cliente`, err);
  reply(() =>
    res.status(500).json({ error: "Error inicializando WhatsApp" }),
  );
});

});


/* ===============================
   ENVIAR MENSAJE
================================ */
app.post("/api/whatsapp/send", async (req, res) => {
  const { phone, slug, message } = req.body;

  console.log(`🧪 [${slug}] SEND solicitado`);

  if (!phone || !slug || !message) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const client = sessions.get(slug);

  // 👇 ESTA ES LA CLAVE DE TODO
  if (!client || !client.__isReady) {
    console.warn(`⚠️ [${slug}] WhatsApp NO READY → envío bloqueado`);
    return res.status(503).json({
      error: "WhatsApp todavía se está conectando. Probá de nuevo en unos segundos.",
    });
  }

  const chatId = `${phone}@c.us`;
  console.log(`🧪 [${slug}] chatId: ${chatId}`);

  try {
    console.log(`🧪 [${slug}] Enviando mensaje...`);
    await client.sendMessage(chatId, message);
    console.log(`✅ [${slug}] WhatsApp enviado OK`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`❌ [${slug}] Error enviando WhatsApp`, err);
    return res.status(500).json({ error: "Error enviando WhatsApp" });
  }
});

/* ===============================
   START SERVER
================================ */
app.listen(port, () => {
  console.log(`🚀 Servidor WhatsApp escuchando en puerto ${port}`);
});
