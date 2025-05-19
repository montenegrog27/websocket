import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config();

// ✅ Inicializar Firebase Admin con variable FIREBASE_SERVICE_ACCOUNT
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

const port = process.env.PORT || 3001;
const server = http.createServer();
const wss = new WebSocketServer({ server });

const trackingGroups = new Map();

wss.on('connection', (ws) => {
  let joinedTrackingId = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Cliente se une a un trackingId
      if (data.type === 'join' && data.trackingId) {
        joinedTrackingId = data.trackingId;

        if (!trackingGroups.has(joinedTrackingId)) {
          trackingGroups.set(joinedTrackingId, new Set());
        }
        trackingGroups.get(joinedTrackingId).add(ws);

        // ✅ Enviar estado inicial del pedido al cliente
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

      // 🔁 Recibir ubicación del repartidor y reenviar a los suscriptores
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
    if (joinedTrackingId && trackingGroups.has(joinedTrackingId)) {
      trackingGroups.get(joinedTrackingId).delete(ws);
      if (trackingGroups.get(joinedTrackingId).size === 0) {
        trackingGroups.delete(joinedTrackingId);
      }
    }
  });
});

server.listen(port, () => {
  console.log(`✅ WebSocket server running on port ${port}`);
});
