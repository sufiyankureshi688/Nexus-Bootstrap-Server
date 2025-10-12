const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// WebSocket server configuration
const wss = new WebSocket.Server({ 
  server,
  clientTracking: true,
  perMessageDeflate: false 
});

const peers = new Map();

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('🔌 New connection from:', clientIp);
  let peerId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📨 Received:', data.type, 'from', data.peerId || 'unknown');

      switch(data.type) {
        case 'register':
          peerId = data.peerId;
          peers.set(peerId, {
            ws,
            username: data.username,
            walletAddress: data.walletAddress,
            timestamp: Date.now()
          });
          
          console.log(`✅ Peer registered: ${data.username} (${peerId})`);
          console.log(`👥 Total peers: ${peers.size}`);
          
          const peerList = Array.from(peers.entries())
            .filter(([id]) => id !== peerId)
            .map(([id, info]) => ({
              peerId: id,
              username: info.username,
              walletAddress: info.walletAddress
            }));
          
          ws.send(JSON.stringify({
            type: 'peer-list',
            peers: peerList
          }));
          
          broadcast({
            type: 'peer-joined',
            peerId,
            username: data.username,
            walletAddress: data.walletAddress
          }, peerId);
          break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
          const targetPeer = peers.get(data.targetPeerId);
          if (targetPeer && targetPeer.ws.readyState === WebSocket.OPEN) {
            targetPeer.ws.send(JSON.stringify({
              ...data,
              fromPeerId: peerId
            }));
            console.log(`📤 Forwarded ${data.type} from ${peerId} to ${data.targetPeerId}`);
          } else {
            console.warn(`⚠️ Target peer ${data.targetPeerId} not found or disconnected`);
          }
          break;

        case 'find-peers':
          const availablePeers = Array.from(peers.entries())
            .filter(([id]) => id !== peerId)
            .map(([id, info]) => ({
              peerId: id,
              username: info.username,
              walletAddress: info.walletAddress
            }));
          
          ws.send(JSON.stringify({
            type: 'peers-found',
            peers: availablePeers
          }));
          console.log(`📤 Sent ${availablePeers.length} peers to ${peerId}`);
          break;
      }
    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  });

  ws.on('close', () => {
    if (peerId) {
      console.log(`🔌 Peer disconnected: ${peerId}`);
      peers.delete(peerId);
      console.log(`👥 Total peers: ${peers.size}`);
      
      broadcast({
        type: 'peer-left',
        peerId
      }, peerId);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error for peer:', peerId, error.message);
  });

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('⚠️ Terminating inactive connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

function broadcast(message, excludePeerId) {
  let sent = 0;
  peers.forEach((peer, id) => {
    if (id !== excludePeerId && peer.ws.readyState === WebSocket.OPEN) {
      try {
        peer.ws.send(JSON.stringify(message));
        sent++;
      } catch (error) {
        console.error(`❌ Error broadcasting to ${id}:`, error.message);
      }
    }
  });
  if (sent > 0) {
    console.log(`📤 Broadcast sent to ${sent} peer(s)`);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    peers: peers.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'NexusTree Signaling Server',
    status: 'running',
    peers: peers.size,
    version: '1.0.0'
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`📡 Listening on all interfaces (0.0.0.0)`);
  console.log(`🏥 Health check available at /health`);
});

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, closing server...');
  clearInterval(pingInterval);
  wss.close(() => {
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
});
