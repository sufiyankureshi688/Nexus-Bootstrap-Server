const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Socket.IO with enhanced CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true
});

// Enhanced peer storage with metadata
const peers = new Map();

class DHTNode {
  constructor() {
    this.routingTable = new Map();
  }

  addPeer(peerId, walletAddress, socketId, metadata = {}) {
    this.routingTable.set(peerId, {
      id: peerId,
      walletAddress,
      socketId,
      username: metadata.username,
      displayName: metadata.displayName,
      bio: metadata.bio,
      lastSeen: Date.now(),
      connections: 0
    });
    console.log(
      `✅ Peer added: ${metadata.username || walletAddress.substring(0, 8)}... (${this.routingTable.size} total)`
    );
  }

  removePeer(peerId) {
    const peer = this.routingTable.get(peerId);
    if (peer) {
      console.log(
        `❌ Peer removed: ${peer.username || peer.walletAddress.substring(0, 8)}...`
      );
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
    name: 'Nexus Bootstrap Server (Enhanced)',
    version: '2.0.0',
    peers: dht.getPeerCount(),
    uptime: Math.floor(process.uptime()),
    features: ['gossip', 'metadata', 'crawling']
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
    username: p.username,
    displayName: p.displayName,
    lastSeen: p.lastSeen,
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

  // ENHANCED: Register with metadata
  socket.on('register', (data) => {
    const { walletAddress, peerId, username, displayName, bio } = data;
    
    if (!walletAddress) {
      socket.emit('error', { message: 'Wallet address required' });
      return;
    }

    currentPeerId = peerId || socket.id;
    
    // Store with metadata
    dht.addPeer(currentPeerId, walletAddress, socket.id, {
      username,
      displayName,
      bio
    });
    
    peers.set(socket.id, {
      id: currentPeerId,
      walletAddress,
      socketId: socket.id,
      username,
      displayName,
      bio,
      connectedAt: Date.now()
    });

    socket.emit('registered', {
      peerId: currentPeerId,
      bootstrapNode: true
    });

    // Broadcast to all OTHER peers (not yourself)
    socket.broadcast.emit('peer-joined', {
      peerId: currentPeerId,
      walletAddress,
      username,
      displayName,
      bio
    });

    console.log(
      `✅ Peer registered: ${username || walletAddress.substring(0, 8)}... as ${currentPeerId.substring(0, 8)}`
    );
  });

  socket.on('find-node', (data) => {
    const { targetWalletAddress, k } = data;
    console.log(`🔍 Find node: ${targetWalletAddress?.substring(0, 8)}...`);

    const closestPeers = dht.findClosestPeers(targetWalletAddress, k || 20);
    
    socket.emit('found-nodes', {
      peers: closestPeers.map(p => ({
        id: p.id,
        walletAddress: p.walletAddress,
        username: p.username,
        displayName: p.displayName,
        bio: p.bio,
        socketId: p.socketId
      }))
    });

    console.log(`📤 Sent ${closestPeers.length} peers`);
  });

  socket.on('get-peers', () => {
    const allPeers = dht.getAllPeers().map(p => ({
      id: p.id,
      walletAddress: p.walletAddress,
      username: p.username,
      displayName: p.displayName,
      bio: p.bio
    }));

    socket.emit('peers-list', { peers: allPeers });
  });

  // NEW: Gossip broadcast (to ALL peers)
  socket.on('gossip', (message) => {
    console.log(`📢 Gossip from ${message.sender.substring(0, 8)}: ${message.type}`);
    
    // Broadcast to ALL other peers
    socket.broadcast.emit('gossip', message);
  });

  // NEW: Gossip to specific peer
  socket.on('gossip_to', (data) => {
    const { to, message } = data;
    
    // Find target peer's socket
    const targetPeer = Array.from(peers.values()).find(p => p.id === to);
    
    if (targetPeer) {
      io.to(targetPeer.socketId).emit('gossip', message);
      console.log(`📨 Gossip forwarded to ${to.substring(0, 8)}`);
    } else {
      socket.emit('error', { message: 'Peer not found', peerId: to });
    }
  });

  socket.on('signal', (data) => {
    const { to, from, signal } = data;
    
    const targetPeer = Array.from(peers.values()).find(p => p.id === to);
    
    if (targetPeer) {
      io.to(targetPeer.socketId).emit('signal', {
        from,
        signal
      });
      console.log(`📨 Signal: ${from?.substring(0, 8)} → ${to?.substring(0, 8)}`);
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
║   Nexus Bootstrap Server v2.0         ║
║   Port: ${PORT}                         ║
║   Features: Gossip + Metadata         ║
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', promise, 'reason:', reason);
});
