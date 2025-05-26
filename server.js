import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import url from 'url';

dotenv.config();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const port = process.env.PORT || 3001;
const server = http.createServer();

const wss = new WebSocketServer({ server });

const trackingGroups = new Map(); // Para seguimiento de pedidos
const allClients = new Set(); // Para WhatsApp inbox

wss.on('connection', (ws) => {
  let joinedTrackingId = null;

  allClients.add(ws);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Cliente se une a un trackingId específico
      if (data.type === 'join' && data.trackingId) {
        joinedTrackingId = data.trackingId;

        if (!trackingGroups.has(joinedTrackingId)) {
          trackingGroups.set(joinedTrackingId, new Set());
        }
        trackingGroups.get(joinedTrackingId).add(ws);

        // Enviar estado actual del pedido
        const snap = await db
          .collection('orders')
          .where('trackingId', '==', joinedTrackingId)
          .limit(1)
          .get();

        if (!snap.empty) {
          const order = snap.docs[0].data();
          ws.send(
            JSON.stringify({
              type: 'status',
              status: order.status || 'preparing',
            })
          );
        }

        return;
      }

      // Reenviar ubicación del repartidor
      if (data.type === 'location' && data.trackingId && data.lat && data.lng) {
        const group = trackingGroups.get(data.trackingId);
        if (group) {
          group.forEach((client) => {
            if (client.readyState === ws.OPEN) {
              client.send(
                JSON.stringify({
                  type: 'update',
                  lat: data.lat,
                  lng: data.lng,
                })
              );
            }
          });
        }
      }
    } catch (err) {
      console.error('❌ Error handling message:', err);
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);
    if (joinedTrackingId && trackingGroups.has(joinedTrackingId)) {
      trackingGroups.get(joinedTrackingId).delete(ws);
      if (trackingGroups.get(joinedTrackingId).size === 0) {
        trackingGroups.delete(joinedTrackingId);
      }
    }
  });
});

// 📩 Endpoint HTTP para notificar que hay nuevos mensajes de WhatsApp
server.on('request', async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'POST' && parsed.pathname === '/notify-whatsapp') {
    // Emitir evento a todos los clientes conectados
    allClients.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: 'whatsapp-new-message' }));
      }
    });

    res.writeHead(200);
    res.end('Notificación enviada a todos los clientes WebSocket.');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`✅ WebSocket server running on port ${port}`);
});
