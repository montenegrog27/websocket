import express from "express";
import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode";
import cors from "cors";

const port = process.env.PORT || 3001;
const app = express();
app.use(cors()); // 👈 Agrega esta línea

// Middleware básico
app.use(express.json());

const sessions = new Map(); // slug -> client

// Ruta para obtener QR
app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug requerido" });

  // Si ya hay una sesión activa
  if (sessions.has(slug)) {
    const client = sessions.get(slug);
    if (client.info) {
      return res.json({ connected: true });
    }
  }

  // Crear nuevo cliente WhatsApp
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: slug }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  sessions.set(slug, client);

  // Mostrar QR solo una vez
  let qrSent = false;
  client.on("qr", async (qr) => {
    if (!qrSent) {
      qrSent = true;
      const qrImage = await qrcode.toDataURL(qr);
      res.json({ qr: qrImage });
    }
  });

  client.on("ready", () => {
    console.log(`✅ WhatsApp conectado para ${slug}`);
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ Fallo de autenticación (${slug}):`, msg);
  });

  client.on("disconnected", (reason) => {
    console.warn(`🔌 Sesión desconectada (${slug}):`, reason);
    sessions.delete(slug);
  });

  client.initialize();
});

// Ruta raíz (opcional)
app.get("/", (req, res) => {
  res.send("✅ WhatsApp backend corriendo.");
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Servidor WhatsApp en http://localhost:${port}`);
});
