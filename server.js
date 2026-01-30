import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const sessions = new Map();

/* ======================================================
   PARCHE + LOGS PROFUNDOS sendSeen / markedUnread
====================================================== */
const disableSendSeen = async (client, slug) => {
  console.log(`🧪 [${slug}] Intentando parchear sendSeen...`);

  try {
    console.log(`🧪 [${slug}] pupPage existe?`, !!client.pupPage);

    if (!client.pupPage) {
      console.warn(`⚠️ [${slug}] pupPage NO disponible`);
      return;
    }

    console.log(`🧪 [${slug}] Esperando WWebJS.sendSeen...`);

    await client.pupPage.waitForFunction(
      () => window.WWebJS && window.WWebJS.sendSeen,
      { timeout: 15000 }
    );

    console.log(`🧪 [${slug}] WWebJS.sendSeen detectado`);

    const result = await client.pupPage.evaluate(() => {
      const before = {
        hasWWebJS: !!window.WWebJS,
        hasSendSeen: !!window.WWebJS?.sendSeen,
        hasMarkUnread: !!window.WWebJS?.markUnread,
      };

      if (window.WWebJS) {
        window.WWebJS.sendSeen = async () => {};
        window.WWebJS.markUnread = async () => {};
      }

      const after = {
        hasWWebJS: !!window.WWebJS,
        hasSendSeen: !!window.WWebJS?.sendSeen,
        hasMarkUnread: !!window.WWebJS?.markUnread,
      };

      return { before, after };
    });

    console.log(`🛡️ [${slug}] Parche aplicado`, result);
  } catch (err) {
    console.error(`❌ [${slug}] Error parcheando sendSeen`, err);
  }
};

/* ===============================
   LOGOUT WHATSAPP
================================ */
app.post("/api/whatsapp/logout", async (req, res) => {
  const { slug } = req.body;
  console.log(`🧪 [${slug}] Logout solicitado`);

  const client = sessions.get(slug);
  if (!client) {
    console.warn(`⚠️ [${slug}] Logout: sesión inexistente`);
    return res.status(400).json({ error: "Sesión no encontrada." });
  }

  try {
    await client.logout();
    await client.destroy();
    sessions.delete(slug);

    console.log(`🔒 [${slug}] Sesión cerrada correctamente`);
    return res.json({ ok: true });
  } catch (e) {
    console.error(`❌ [${slug}] Error cerrando sesión`, e);
    return res.status(500).json({ error: "Error cerrando sesión." });
  }
});

/* ===============================
   OBTENER QR / INICIAR SESIÓN
================================ */
app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug } = req.query;
  console.log(`🧪 [${slug}] QR solicitado`);

  if (!slug) return res.status(400).json({ error: "slug requerido" });

  if (sessions.has(slug)) {
    const existing = sessions.get(slug);
    console.log(`🧪 [${slug}] Sesión existente. info?`, !!existing.info);

    if (existing.info) {
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
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  sessions.set(slug, client);

  const timeout = setTimeout(() => {
    console.warn(`⏱️ [${slug}] Timeout esperando QR`);
    res.status(504).json({ error: "Timeout generando QR" });
  }, 15000);

  client.once("qr", async (qr) => {
    clearTimeout(timeout);
    console.log(`📸 [${slug}] QR generado`);
    const qrImage = await qrcode.toDataURL(qr);
    res.json({ qr: qrImage });
  });

  client.on("ready", async () => {
    console.log(`✅ [${slug}] WhatsApp READY`);
    console.log(`🧪 [${slug}] client.info:`, client.info);
    await disableSendSeen(client, slug);
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ [${slug}] Auth failure`, msg);
  });

  client.on("disconnected", (reason) => {
    console.warn(`🔌 [${slug}] Desconectado`, reason);
    sessions.delete(slug);
  });

  client.initialize().catch((err) => {
    console.error(`❌ [${slug}] Error inicializando cliente`, err);
  });
});

/* ===============================
   ENVIAR MENSAJE
================================ */
app.post("/api/whatsapp/send", async (req, res) => {
  const { phone, slug, message } = req.body;

  console.log(`🧪 [${slug}] SEND solicitado`);
  console.log(`🧪 [${slug}] phone:`, phone);
  console.log(`🧪 [${slug}] message length:`, message?.length);

  if (!phone || !slug || !message) {
    console.warn(`⚠️ [${slug}] Datos incompletos`);
    return res.status(400).json({ error: "Faltan datos" });
  }

  const client = sessions.get(slug);

  console.log(`🧪 [${slug}] client existe?`, !!client);
  console.log(`🧪 [${slug}] client.info existe?`, !!client?.info);

  if (!client || !client.info) {
    return res
      .status(503)
      .json({ error: "WhatsApp no conectado para este negocio" });
  }

  const chatId = `${phone}@c.us`;
  console.log(`🧪 [${slug}] chatId construido:`, chatId);

  try {
    console.log(`🧪 [${slug}] Intentando sendMessage...`);
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
