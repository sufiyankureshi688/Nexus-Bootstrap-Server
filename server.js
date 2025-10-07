const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS middleware for HTTP requests
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Data structures
const peers = new Map(); // peerId -> { ws, lastSeen, nodeInfo, address }
const peerStats = {
  totalConnections: 0,
  currentConnections: 0,
  messagesRelayed: 0,
  bootstrapRequests: 0,
  signalingMessages: 0
};

// HTTP endpoints for monitoring
app.get('/', (req, res) => {
  res.json({
    service: 'Nexus Bootstrap & Signaling Server',
    version: '1.0.0',
    status: 'running',
    uptime: process.uptime(),
    stats: {
      ...peerStats,
      activePeers: peers.size
    }
  });
});

app.get('/peers', (req, res) => {
  const peerList = Array.from(peers.entries()).map(([peerId, peer]) => ({
    peerId,
    nodeInfo: peer.nodeInfo,
    lastSeen: peer.lastSeen,
    connected: Date.now() - peer.lastSeen < 30000
  }));
  res.json({ peers: peerList });
});

app.get('/stats', (req, res) => {
  res.json({
    ...peerStats,
    activePeers: peers.size,
    timestamp: Date.now()
  });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let currentPeerId = null;
  const clientAddress = req.socket.remoteAddress;

  peerStats.totalConnections++;
  peerStats.currentConnections++;

  console.log(`New connection from ${clientAddress}`);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Route based on message type
      if (message.type === 'bootstrap') {
        handleBootstrap(message, ws);
      } else if (message.type === 'signaling') {
        handleSignaling(message, ws);
      } else {
        console.log('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error parsing message:', error);
      sendError(ws, 'Invalid message format');
    }
  });

  ws.on('close', () => {
    if (currentPeerId) {
      console.log(`Peer ${currentPeerId} disconnected`);
      peers.delete(currentPeerId);
      peerStats.currentConnections--;
      
      // Notify other peers about disconnection (optional)
      broadcastPeerList();
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // ==================== BOOTSTRAP HANDLER ====================
  function handleBootstrap(message, ws) {
    peerStats.bootstrapRequests++;
    const { action, peerId, nodeInfo } = message;

    switch (action) {
      case 'register':
        handleRegister(peerId, nodeInfo, ws);
        break;
      
      case 'getPeers':
        handleGetPeers(ws);
        break;
      
      case 'heartbeat':
        handleHeartbeat(peerId);
        break;
      
      case 'unregister':
        handleUnregister(peerId);
        break;
      
      default:
        console.log('Unknown bootstrap action:', action);
    }
  }

  function handleRegister(peerId, nodeInfo, ws) {
    if (!peerId) {
      sendError(ws, 'Peer ID required for registration');
      return;
    }

    currentPeerId = peerId;
    
    peers.set(peerId, {
      ws,
      lastSeen: Date.now(),
      nodeInfo: nodeInfo || {},
      address: clientAddress
    });

    console.log(`Peer registered: ${peerId} (Total: ${peers.size})`);

    // Send confirmation with current peer list
    const activePeers = getActivePeers(peerId);
    
    ws.send(JSON.stringify({
      type: 'bootstrap',
      action: 'registered',
      peerId,
      peers: activePeers,
      timestamp: Date.now()
    }));

    // Notify other peers about new peer (optional)
    broadcastPeerJoined(peerId, nodeInfo);
  }

  function handleGetPeers(ws) {
    const activePeers = getActivePeers(currentPeerId);
    
    ws.send(JSON.stringify({
      type: 'bootstrap',
      action: 'peerList',
      peers: activePeers,
      count: activePeers.length,
      timestamp: Date.now()
    }));
  }

  function handleHeartbeat(peerId) {
    if (peerId && peers.has(peerId)) {
      peers.get(peerId).lastSeen = Date.now();
    }
  }

  function handleUnregister(peerId) {
    if (peerId && peers.has(peerId)) {
      peers.delete(peerId);
      console.log(`Peer unregistered: ${peerId}`);
    }
  }

  // ==================== SIGNALING HANDLER ====================
  function handleSignaling(message, ws) {
    peerStats.signalingMessages++;
    peerStats.messagesRelayed++;
    
    const { action, targetPeerId, fromPeerId, payload } = message;

    if (!targetPeerId || !fromPeerId) {
      sendError(ws, 'targetPeerId and fromPeerId required for signaling');
      return;
    }

    switch (action) {
      case 'offer':
        relaySignalingMessage('offer', targetPeerId, fromPeerId, payload);
        break;
      
      case 'answer':
        relaySignalingMessage('answer', targetPeerId, fromPeerId, payload);
        break;
      
      case 'ice-candidate':
        relaySignalingMessage('ice-candidate', targetPeerId, fromPeerId, payload);
        break;
      
      default:
        console.log('Unknown signaling action:', action);
    }
  }

  function relaySignalingMessage(action, targetPeerId, fromPeerId, payload) {
    const targetPeer = peers.get(targetPeerId);

    if (!targetPeer) {
      sendError(ws, `Target peer ${targetPeerId} not found or disconnected`);
      return;
    }

    if (targetPeer.ws.readyState !== WebSocket.OPEN) {
      sendError(ws, `Target peer ${targetPeerId} connection not ready`);
      return;
    }

    try {
      targetPeer.ws.send(JSON.stringify({
        type: 'signaling',
        action,
        fromPeerId,
        payload,
        timestamp: Date.now()
      }));

      console.log(`Relayed ${action} from ${fromPeerId} to ${targetPeerId}`);
    } catch (error) {
      console.error('Error relaying message:', error);
      sendError(ws, 'Failed to relay message');
    }
  }

  // ==================== HELPER FUNCTIONS ====================
  function sendError(ws, error) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        error,
        timestamp: Date.now()
      }));
    }
  }
});

// ==================== UTILITY FUNCTIONS ====================
function getActivePeers(excludePeerId) {
  const now = Date.now();
  const TIMEOUT = 60000; // 60 seconds

  return Array.from(peers.entries())
    .filter(([peerId, peer]) => {
      return peerId !== excludePeerId && (now - peer.lastSeen) < TIMEOUT;
    })
    .map(([peerId, peer]) => ({
      peerId,
      nodeInfo: peer.nodeInfo,
      lastSeen: peer.lastSeen
    }));
}

function broadcastPeerJoined(peerId, nodeInfo) {
  const message = JSON.stringify({
    type: 'bootstrap',
    action: 'peerJoined',
    peerId,
    nodeInfo,
    timestamp: Date.now()
  });

  peers.forEach((peer, id) => {
    if (id !== peerId && peer.ws.readyState === WebSocket.OPEN) {
      try {
        peer.ws.send(message);
      } catch (error) {
        console.error(`Failed to notify peer ${id}:`, error);
      }
    }
  });
}

function broadcastPeerList() {
  const activePeers = getActivePeers(null);
  const message = JSON.stringify({
    type: 'bootstrap',
    action: 'peerListUpdate',
    peers: activePeers,
    timestamp: Date.now()
  });

  peers.forEach((peer) => {
    if (peer.ws.readyState === WebSocket.OPEN) {
      try {
        peer.ws.send(message);
      } catch (error) {
        console.error('Failed to broadcast peer list:', error);
      }
    }
  });
}

// ==================== CLEANUP TASKS ====================
// Clean up stale peers every 60 seconds
setInterval(() => {
  const now = Date.now();
  const STALE_TIMEOUT = 120000; // 2 minutes
  let removedCount = 0;

  for (const [peerId, peer] of peers.entries()) {
    if (now - peer.lastSeen > STALE_TIMEOUT) {
      peers.delete(peerId);
      removedCount++;
      console.log(`Removed stale peer: ${peerId}`);
    }
  }

  if (removedCount > 0) {
    console.log(`Cleanup: Removed ${removedCount} stale peer(s)`);
    broadcastPeerList();
  }
}, 60000);

// Log stats every 5 minutes
setInterval(() => {
  console.log('=== Server Stats ===');
  console.log(`Active Peers: ${peers.size}`);
  console.log(`Total Connections: ${peerStats.totalConnections}`);
  console.log(`Messages Relayed: ${peerStats.messagesRelayed}`);
  console.log(`Bootstrap Requests: ${peerStats.bootstrapRequests}`);
  console.log(`Signaling Messages: ${peerStats.signalingMessages}`);
  console.log('==================');
}, 300000);

// ==================== SERVER STARTUP ====================
const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Nexus Bootstrap & Signaling Server      ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
  console.log('');
  console.log('Services:');
  console.log('  ✓ DHT Bootstrap');
  console.log('  ✓ WebRTC Signaling');
  console.log('  ✓ Peer Discovery');
  console.log('');
  console.log('Ready to accept connections...');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down gracefully...');
  
  // Notify all peers
  const shutdownMessage = JSON.stringify({
    type: 'server',
    action: 'shutdown',
    message: 'Server is shutting down',
    timestamp: Date.now()
  });

  peers.forEach((peer) => {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(shutdownMessage);
      peer.ws.close();
    }
  });

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 5000);
});
