

import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import url from 'url';

dotenv.config();

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert({
    ...serviceAccount,
    privateKey: serviceAccount.private_key.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();
const port = process.env.PORT || 3001;
const server = http.createServer();

const wss = new WebSocketServer({ server });

const trackingGroups = new Map(); // seguimiento por trackingId
const branchGroups = new Map(); // seguimiento por sucursal (para cocina)
const allClients = new Set();

wss.on('connection', (ws) => {
  let joinedTrackingId = null;
  let joinedBranch = null;

  allClients.add(ws);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      // 🔸 Cliente quiere seguir un pedido por trackingId
      if (data.type === 'join' && data.trackingId) {
        joinedTrackingId = data.trackingId;

        if (!trackingGroups.has(joinedTrackingId)) {
          trackingGroups.set(joinedTrackingId, new Set());
        }
        trackingGroups.get(joinedTrackingId).add(ws);

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

      // 🔸 Cliente se une a una sucursal (KDS)
      if (data.type === 'join-branch' && data.branch) {
        joinedBranch = data.branch;

        if (!branchGroups.has(joinedBranch)) {
          branchGroups.set(joinedBranch, new Set());
        }
        branchGroups.get(joinedBranch).add(ws);
        return;
      }

      // 🔸 Ubicación del rider
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

    if (joinedBranch && branchGroups.has(joinedBranch)) {
      branchGroups.get(joinedBranch).delete(ws);
      if (branchGroups.get(joinedBranch).size === 0) {
        branchGroups.delete(joinedBranch);
      }
    }
  });
});

// 🔁 Escuchar en Firestore cambios en órdenes activas
db.collection("orders")
  .where("status", "in", ["ready_to_send", "preparing"])
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const order = { id: change.doc.id, ...change.doc.data() };
      const branch = order.branch;

      if (branchGroups.has(branch)) {
        branchGroups.get(branch).forEach((client) => {
          if (client.readyState === client.OPEN) {
            client.send(
              JSON.stringify({
                type: "order-updated",
                order,
              })
            );
          }
        });
      }
    });
  });

// 📩 Notificación para WhatsApp inbox
server.on('request', async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'POST' && parsed.pathname === '/notify-whatsapp') {
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
