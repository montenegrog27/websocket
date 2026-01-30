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

/* ======================================================
   PARCHE DEFINITIVO PARA BUG sendSeen / markedUnread
====================================================== */
const disableSendSeen = async (client, slug) => {
  try {
    if (!client.pupPage) {
      console.warn(`⚠️ pupPage no disponible (${slug})`);
      return;
    }

    await client.pupPage.waitForFunction(
      () => window.WWebJS && window.WWebJS.sendSeen,
      { timeout: 15000 }
    );

    await client.pupPage.evaluate(() => {
      // Neutralizamos funciones problemáticas
      if (window.WWebJS) {
        window.WWebJS.sendSeen = async () => {};
        window.WWebJS.markUnread = async () => {};
      }
    });

    console.log(`🛡️ sendSeen / markUnread desactivados (${slug})`);
  } catch (err) {
    console.warn(`⚠️ No se pudo parchear sendSeen (${slug})`, err?.message);
  }
};

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
    await client.logout();
    await client.destroy();
    sessions.delete(slug);

    console.log(`🔒 Sesión cerrada para ${slug}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error(`❌ Error cerrando sesión (${slug})`, e);
    return res.status(500).json({ error: "Error cerrando sesión." });
  }
});

/* ===============================
   OBTENER QR / INICIAR SESIÓN
================================ */
app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug requerido" });

  // Si ya existe sesión válida → devolver conectado
  if (sessions.has(slug)) {
    const existing = sessions.get(slug);

    if (existing.info) {
      return res.json({ connected: true });
    } else {
      try {
        await existing.destroy();
      } catch {}
      sessions.delete(slug);
    }
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: slug }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  sessions.set(slug, client);

  // Timeout defensivo
  const timeout = setTimeout(() => {
    console.log(`⏱️ Timeout esperando QR (${slug})`);
    res.status(504).json({ error: "Timeout generando QR" });
  }, 15000);

  client.once("qr", async (qr) => {
    clearTimeout(timeout);
    const qrImage = await qrcode.toDataURL(qr);
    res.json({ qr: qrImage });
  });

  client.on("ready", async () => {
    console.log(`✅ WhatsApp conectado (${slug})`);
    await disableSendSeen(client, slug);
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ Auth failure (${slug})`, msg);
  });

  client.on("disconnected", (reason) => {
    console.log(`🔌 WhatsApp desconectado (${slug}):`, reason);
    sessions.delete(slug);
  });

  client.initialize().catch((err) => {
    console.error(`❌ Error inicializando cliente (${slug})`, err);
  });
});

/* ===============================
   ENVIAR MENSAJE
================================ */
app.post("/api/whatsapp/send", async (req, res) => {
  const { phone, slug, message } = req.body;

  if (!phone || !slug || !message) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const client = sessions.get(slug);

  if (!client || !client.info) {
    return res
      .status(503)
      .json({ error: "WhatsApp no conectado para este negocio" });
  }

  try {
    const chatId = `${phone}@c.us`;

    await client.sendMessage(chatId, message);

    console.log(`✅ WhatsApp enviado a ${phone} (${slug})`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`❌ Error enviando WhatsApp (${slug})`, err);
    return res.status(500).json({ error: "Error enviando WhatsApp" });
  }
});

/* ===============================
   START SERVER
================================ */
app.listen(port, () => {
  console.log(`🚀 Servidor WhatsApp escuchando en puerto ${port}`);
});
