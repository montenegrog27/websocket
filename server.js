import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import whatsapp from "whatsapp-web.js";

const { Client, LocalAuth } = whatsapp;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

const sessions = new Map(); // slug -> client

app.get("/api/whatsapp/qrcode", async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug requerido" });

  if (sessions.has(slug)) {
    const client = sessions.get(slug);
    if (client.info) {
      return res.json({ connected: true });
    }
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: slug }),
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });

  sessions.set(slug, client);

  client.on("qr", async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    res.json({ qr: qrImage });
  });

  client.on("ready", () => {
    console.log(`✅ WhatsApp conectado para ${slug}`);
  });

  client.initialize();
});

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en puerto ${port}`);
});
