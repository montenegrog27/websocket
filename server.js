import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const sessions = new Map(); // Map slug -> client

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
    console.error(`❌ Error cerrando sesión para ${slug}:`, e);
    return res.status(500).json({ error: "Error cerrando sesión." });
  }
});

app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug requerido" });

  // Si ya hay una sesión, la revisamos
  if (sessions.has(slug)) {
    const client = sessions.get(slug);

    if (client.info) {
      return res.json({ connected: true });
    } else {
      try {
        await client.destroy();
        console.log(`♻️ Cliente viejo destruido para ${slug}`);
      } catch (e) {
        console.warn(`⚠️ Error destruyendo cliente viejo (${slug}):`, e);
      }
      sessions.delete(slug);
    }
  }

  // Crear nuevo cliente
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

  // Seguridad: timeout si no se genera el QR
  const timeout = setTimeout(() => {
    console.log(`⏱️ Timeout esperando QR para ${slug}`);
    res.status(504).json({ error: "Timeout generando QR" });
  }, 15000);

  client.once("qr", async (qr) => {
    clearTimeout(timeout);
    const qrImage = await qrcode.toDataURL(qr);
    res.json({ qr: qrImage });
  });

  client.on("ready", () => {
    console.log(`✅ WhatsApp conectado para ${slug}`);
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ Falló la autenticación (${slug}):`, msg);
  });

  client.on("disconnected", (reason) => {
    console.log(`🔌 Desconectado (${slug}):`, reason);
    sessions.delete(slug);
  });

  // Capturar errores de inicialización
  client.initialize().catch((err) => {
    console.error(`❌ Error inicializando cliente (${slug}):`, err);
  });
});

app.post("/api/whatsapp/send", async (req, res) => {
  const { phone, slug, message } = req.body;

  if (!phone || !slug || !message) {
    return res.status(400).json({ error: "Faltan datos: phone, slug o message." });
  }

  const client = sessions.get(slug);

  if (!client || !client.info) {
    return res.status(503).json({ error: "WhatsApp no está conectado para este negocio." });
  }

  try {
    const chatId = `${phone}@c.us`;

    // 👇 Esto evita el error de 'markedUnread'
    const chat = await client.getChatById(chatId);
    if (!chat) {
      return res.status(404).json({ error: "No se pudo obtener el chat." });
    }

    await client.sendMessage(chatId, message);
    console.log(`✅ Mensaje enviado a ${phone} desde ${slug}`);
    return res.json({ ok: true });

  } catch (err) {
    console.error(`❌ Error enviando mensaje a ${phone}:`, err);
    return res.status(500).json({ error: "Error enviando mensaje." });
  }
});

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en puerto ${port}`);
});
