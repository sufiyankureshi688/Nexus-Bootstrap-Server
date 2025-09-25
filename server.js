const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// HARDCODED CONFIGURATION (no .env dependency)
const CONFIG = {
  PORT: 3000,
  SERVER_ID: 'nexus-bootstrap-1',
  NODE_ENV: 'production',
  MAX_PEERS: 50,
  CLEANUP_INTERVAL: 120000, // 2 minutes
  PEER_TIMEOUT: 600000 // 10 minutes
};

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// In-memory peer storage (simple and fast)
class PeerManager {
  constructor() {
    this.peers = new Map();
    this.connections = new Map(); // WebSocket connections
    this.lastCleanup = Date.now();
  }

  addPeer(peerId, peerData) {
    const peer = {
      id: peerId,
      ...peerData,
      lastSeen: Date.now(),
      joined: Date.now()
    };
    
    this.peers.set(peerId, peer);
    console.log(`Peer joined: ${peerId} (Total: ${this.peers.size})`);
    return peer;
  }

  removePeer(peerId) {
    const removed = this.peers.delete(peerId);
    this.connections.delete(peerId);
    if (removed) {
      console.log(`Peer left: ${peerId} (Total: ${this.peers.size})`);
    }
    return removed;
  }

  updatePeerActivity(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
      this.peers.set(peerId, peer);
    }
  }

  getActivePeers(maxAge = 300000) { // 5 minutes default
    const now = Date.now();
    const activePeers = [];
    
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen < maxAge) {
        activePeers.push(peer);
      }
    }
    
    return activePeers;
  }

  cleanupStalePeers(maxAge = CONFIG.PEER_TIMEOUT) {
    const now = Date.now();
    const stalePeers = [];
    
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen > maxAge) {
        stalePeers.push(peerId);
      }
    }
    
    stalePeers.forEach(peerId => this.removePeer(peerId));
    return stalePeers.length;
  }

  getRandomPeers(count = 10, excludePeerId = null) {
    const activePeers = this.getActivePeers().filter(peer => peer.id !== excludePeerId);
    
    // Shuffle and return up to count peers
    const shuffled = activePeers.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }
}

const peerManager = new PeerManager();

// Cleanup stale peers automatically
setInterval(() => {
  const cleanedUp = peerManager.cleanupStalePeers();
  if (cleanedUp > 0) {
    console.log(`Cleaned up ${cleanedUp} stale peers`);
  }
}, CONFIG.CLEANUP_INTERVAL);

// API Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    serverId: CONFIG.SERVER_ID,
    totalPeers: peerManager.peers.size,
    activePeers: peerManager.getActivePeers().length,
    uptime: process.uptime()
  });
});

// MAIN ENDPOINT: Get peer list for DHT bootstrap
app.get('/peers', (req, res) => {
  try {
    const requestingPeerId = req.query.peerId;
    const maxPeers = parseInt(req.query.limit) || 10;
    
    const peers = peerManager.getRandomPeers(maxPeers, requestingPeerId);
    
    res.json({
      success: true,
      peers: peers.map(peer => ({
        id: peer.id,
        address: peer.address || 'unknown',
        port: peer.port || 8080,
        lastSeen: peer.lastSeen,
        capabilities: peer.capabilities || ['dht', 'webrtc']
      })),
      totalAvailable: peerManager.getActivePeers().length,
      bootstrapServer: CONFIG.SERVER_ID,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error getting peers:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Register peer with network
app.post('/announce', (req, res) => {
  try {
    const { peerId, address, port, capabilities } = req.body;
    
    if (!peerId) {
      return res.status(400).json({ success: false, error: 'peerId is required' });
    }
    
    const peer = peerManager.addPeer(peerId, {
      address: address || req.ip,
      port: port || 8080,
      capabilities: capabilities || ['dht', 'webrtc']
    });
    
    res.json({
      success: true,
      peer,
      message: 'Peer announced successfully',
      bootstrapServer: CONFIG.SERVER_ID
    });
  } catch (error) {
    console.error('Error announcing peer:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Update peer activity (heartbeat)
app.post('/heartbeat', (req, res) => {
  try {
    const { peerId } = req.body;
    
    if (!peerId) {
      return res.status(400).json({ success: false, error: 'peerId is required' });
    }
    
    peerManager.updatePeerActivity(peerId);
    
    res.json({
      success: true,
      message: 'Heartbeat updated',
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error updating heartbeat:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// WebRTC Signaling endpoint
app.post('/signal', (req, res) => {
  try {
    const { to, from, message } = req.body;
    
    if (!to || !from || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'to, from, and message are required' 
      });
    }
    
    // Forward via WebSocket if available
    const targetConnection = peerManager.connections.get(to);
    if (targetConnection && targetConnection.readyState === WebSocket.OPEN) {
      targetConnection.send(JSON.stringify({
        type: 'signaling',
        from,
        to,
        message
      }));
      
      res.json({ success: true, message: 'Signal forwarded via WebSocket' });
    } else {
      res.json({ 
        success: false, 
        error: 'Target peer not connected',
        suggestion: 'Peer should connect via WebSocket for signaling'
      });
    }
  } catch (error) {
    console.error('Error handling signal:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Network statistics
app.get('/stats', (req, res) => {
  const stats = {
    serverId: CONFIG.SERVER_ID,
    totalPeers: peerManager.peers.size,
    activePeers: peerManager.getActivePeers().length,
    webSocketConnections: peerManager.connections.size,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: Date.now()
  };
  
  res.json(stats);
});

// WebSocket server for real-time signaling
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let peerId = null;
  
  console.log('New WebSocket connection established');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'register':
          peerId = message.peerId;
          if (peerId) {
            peerManager.connections.set(peerId, ws);
            peerManager.updatePeerActivity(peerId);
            console.log(`Peer ${peerId} registered WebSocket`);
            
            ws.send(JSON.stringify({
              type: 'registered',
              peerId,
              serverId: CONFIG.SERVER_ID,
              timestamp: Date.now()
            }));
          }
          break;
          
        case 'signaling':
          const { to, from, signalingMessage } = message;
          const targetConnection = peerManager.connections.get(to);
          
          if (targetConnection && targetConnection.readyState === WebSocket.OPEN) {
            targetConnection.send(JSON.stringify({
              type: 'signaling',
              from,
              to,
              message: signalingMessage
            }));
          }
          break;
          
        case 'heartbeat':
          if (message.peerId) {
            peerManager.updatePeerActivity(message.peerId);
          }
          break;
          
        default:
          console.log('Unknown WebSocket message type:', message.type);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });
  
  ws.on('close', () => {
    if (peerId) {
      peerManager.connections.delete(peerId);
      console.log(`Peer ${peerId} disconnected from WebSocket`);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Start server with hardcoded port
const PORT = CONFIG.PORT;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Nexus Bootstrap Server RUNNING`);
  console.log(`=================================`);
  console.log(`Server ID: ${CONFIG.SERVER_ID}`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${CONFIG.NODE_ENV}`);
  console.log(`HTTP API: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Health Check: http://localhost:${PORT}/health`);
  console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Nexus Bootstrap Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down...');
  server.close(() => {
    console.log('Nexus Bootstrap Server closed');
    process.exit(0);
  });
});
