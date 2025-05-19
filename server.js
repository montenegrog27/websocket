// server.js
import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

dotenv.config();

const port = process.env.PORT || 3001;
const server = http.createServer();
const wss = new WebSocketServer({ server });

// Inicializar Firebase Admin
initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const trackingGroups = new Map();

wss.on('connection', (ws) => {
  let joinedTrackingId = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      // Unirse a un trackingId
      if (data.type === 'join' && data.trackingId) {
        joinedTrackingId = data.trackingId;

        if (!trackingGroups.has(joinedTrackingId)) {
          trackingGroups.set(joinedTrackingId, new Set());
        }
        trackingGroups.get(joinedTrackingId).add(ws);

        // Consultar estado actual del pedido y enviarlo
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef
          .where('trackingId', '==', joinedTrackingId)
          .limit(1)
          .get();

        if (!snapshot.empty) {
          const order = snapshot.docs[0].data();
          ws.send(
            JSON.stringify({
              type: 'status',
              status: order.status || 'preparing',
            })
          );
        }
        return;
      }

      // Enviar ubicación a todos los clientes conectados al trackingId
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
      console.error('Error handling message:', err);
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
