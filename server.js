import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

const sessions = new Map(); // Map slug -> client

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
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });

  sessions.set(slug, client);

  // Seguridad: si en 15s no pasa nada, devolvemos timeout
  const timeout = setTimeout(() => {
    console.log(`⏱️ Timeout esperando QR para ${slug}`);
    res.status(504).json({ error: "Timeout generando QR" });
  }, 15000);

  // Solo respondemos una vez con el QR
  client.once("qr", async (qr) => {
    clearTimeout(timeout);
    const qrImage = await qrcode.toDataURL(qr);
    res.json({ qr: qrImage });
  });

  // Cliente listo
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

  client.initialize();
});

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en puerto ${port}`);
});
