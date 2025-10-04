const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto'); // Node built-in, no install needed

const app = express();
const server = http.createServer(app);

// CORS configuration
app.use(cors());
app.use(express.json());

// Socket.IO with CORS - FIXED for React Native
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket'],  // Add polling first
  allowEIO3: true  // Compatibility
});

// Peer registry
const peers = new Map();

// DHT routing table (simplified)
class DHTNode {
  constructor() {
    this.routingTable = new Map();
  }

  addPeer(peerId, walletAddress, socketId) {
    this.routingTable.set(peerId, {
      id: peerId,
      walletAddress,
      socketId,
      lastSeen: Date.now(),
      connections: 0
    });
    console.log(`✅ Peer added to DHT: ${walletAddress.substring(0, 8)}... (${this.routingTable.size} total)`);
  }

  removePeer(peerId) {
    const peer = this.routingTable.get(peerId);
    if (peer) {
      console.log(`❌ Peer removed from DHT: ${peer.walletAddress.substring(0, 8)}...`);
      this.routingTable.delete(peerId);
    }
  }

  findClosestPeers(targetWalletAddress, k = 20) {
    const targetHash = this.hashAddress(targetWalletAddress);
    
    const peersWithDistance = Array.from(this.routingTable.values())
      .map(peer => ({
        peer,
        distance: this.xorDistance(
          targetHash,
          this.hashAddress(peer.walletAddress)
        )
      }))
      .sort((a, b) => a.distance.localeCompare(b.distance))
      .slice(0, k)
      .map(item => item.peer);

    return peersWithDistance;
  }

  hashAddress(address) {
    return crypto.createHash('sha256').update(address).digest('hex');
  }

  xorDistance(hash1, hash2) {
    let distance = '';
    for (let i = 0; i < Math.min(hash1.length, hash2.length); i++) {
      const xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
      distance += xor.toString(16);
    }
    return distance;
  }

  getAllPeers() {
    return Array.from(this.routingTable.values());
  }

  getPeerCount() {
    return this.routingTable.size;
  }

  cleanup() {
    const timeout = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();
    let removed = 0;

    for (const [peerId, peer] of this.routingTable.entries()) {
      if (now - peer.lastSeen > timeout) {
        this.routingTable.delete(peerId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} inactive peers`);
    }
  }
}

const dht = new DHTNode();

// HTTP Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Nexus Bootstrap Server',
    version: '1.0.0',
    peers: dht.getPeerCount(),
    uptime: Math.floor(process.uptime())
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    peers: dht.getPeerCount(),
    timestamp: Date.now()
  });
});

app.get('/peers', (req, res) => {
  const allPeers = dht.getAllPeers().map(p => ({
    id: p.id,
    walletAddress: p.walletAddress,
    lastSeen: p.lastSeen,
    connections: p.connections
  }));
  
  res.json({
    total: allPeers.length,
    peers: allPeers
  });
});

app.get('/stats', (req, res) => {
  res.json({
    totalPeers: dht.getPeerCount(),
    activeConnections: io.sockets.sockets.size,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage()
  });
});

// Socket.IO Events
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  
  let currentPeerId = null;

  socket.on('register', (data) => {
    const { walletAddress, peerId } = data;
    
    if (!walletAddress) {
      socket.emit('error', { message: 'Wallet address required' });
      return;
    }

    currentPeerId = peerId || socket.id;
    
    dht.addPeer(currentPeerId, walletAddress, socket.id);
    
    peers.set(socket.id, {
      id: currentPeerId,
      walletAddress,
      socketId: socket.id,
      connectedAt: Date.now()
    });

    socket.emit('registered', {
      peerId: currentPeerId,
      bootstrapNode: true
    });

    socket.broadcast.emit('peer-joined', {
      peerId: currentPeerId,
      walletAddress
    });

    console.log(`✅ Peer registered: ${walletAddress.substring(0, 8)}... as ${currentPeerId}`);
  });

  socket.on('find-node', (data) => {
    const { targetWalletAddress, k } = data;
    console.log(`🔍 Find node request for: ${targetWalletAddress?.substring(0, 8)}...`);

    const closestPeers = dht.findClosestPeers(targetWalletAddress, k || 20);
    
    socket.emit('found-nodes', {
      peers: closestPeers.map(p => ({
        id: p.id,
        walletAddress: p.walletAddress,
        socketId: p.socketId
      }))
    });

    console.log(`📤 Sent ${closestPeers.length} closest peers`);
  });

  socket.on('get-peers', () => {
    const allPeers = dht.getAllPeers().map(p => ({
      id: p.id,
      walletAddress: p.walletAddress
    }));

    socket.emit('peers-list', { peers: allPeers });
  });

  socket.on('signal', (data) => {
    const { to, from, signal } = data;
    
    const targetPeer = Array.from(peers.values()).find(p => p.id === to);
    
    if (targetPeer) {
      io.to(targetPeer.socketId).emit('signal', {
        from,
        signal
      });
      console.log(`📨 Forwarded signal: ${from?.substring(0, 8)} → ${to?.substring(0, 8)}`);
    } else {
      socket.emit('error', { message: 'Peer not found', peerId: to });
    }
  });

  socket.on('announce', (data) => {
    socket.broadcast.emit('peer-announcement', data);
  });

  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
    
    if (currentPeerId) {
      const peer = dht.routingTable.get(currentPeerId);
      if (peer) {
        peer.lastSeen = Date.now();
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}`);
    
    if (currentPeerId) {
      dht.removePeer(currentPeerId);
      
      socket.broadcast.emit('peer-left', {
        peerId: currentPeerId
      });
    }
    
    peers.delete(socket.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Periodic cleanup
setInterval(() => {
  dht.cleanup();
}, 5 * 60 * 1000);

// Server startup
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   Nexus Bootstrap Server Running      ║
║   Port: ${PORT}                         ║
║   Environment: ${process.env.NODE_ENV || 'production'}
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
