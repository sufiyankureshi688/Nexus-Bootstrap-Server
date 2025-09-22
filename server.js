// nexus-bootstrap-server.js - Production Bootstrap Server (FIXED VERSION)
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

class NexusBootstrapServer {
  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.activePeers = new Map(); // peerId -> peer data
    this.peersByRegion = new Map(); // region -> Set(peerIds)
    this.nodeStats = {
      totalRegistrations: 0,
      activePeers: 0,
      official: 0,
      forks: 0,
      custom: 0,
      peakPeers: 0,
      startTime: Date.now()
    };
    
    // Add missing properties
    this.lastStatsLog = 0;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.startCleanupTasks();
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: '*', // Allow React Native apps
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      headers: ['Content-Type', 'Authorization']
    }));
    
    this.app.use(express.json({ limit: '10mb' }));
    
    // Rate limiting for mobile apps
    const limiter = rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute per IP
      message: { error: 'Too many requests' }
    });
    this.app.use(limiter);
    
    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        uptime: Date.now() - this.nodeStats.startTime,
        activePeers: this.activePeers.size,
        memory: process.memoryUsage(),
        timestamp: Date.now()
      });
    });

    // Main bootstrap endpoint
    this.app.post('/register', async (req, res) => {
      try {
        const result = await this.handlePeerRegistration(req.body, req.ip);
        res.json(result);
      } catch (error) {
        console.error('Registration failed:', error);
        res.status(500).json({ error: 'Registration failed' });
      }
    });

    // Get network statistics
    this.app.get('/stats', (req, res) => {
      const appVariants = this.getAppVariants();
      res.json({
        ...this.nodeStats,
        activePeers: this.activePeers.size,
        appVariants,
        regionDistribution: this.getRegionDistribution(),
        recentActivity: this.getRecentActivity()
      });
    });

    // Peer lookup for DHT queries
    this.app.get('/peers/:nodeId', (req, res) => {
      const { nodeId } = req.params;
      const peer = this.activePeers.get(nodeId);
      
      if (peer) {
        res.json({
          found: true,
          peer: {
            nodeId,
            address: peer.address,
            lastSeen: peer.lastSeen,
            classification: peer.classification
          }
        });
      } else {
        res.status(404).json({ found: false });
      }
    });

    // Heartbeat endpoint for keeping peers alive
    this.app.post('/heartbeat', (req, res) => {
      const { nodeId } = req.body;
      if (nodeId && this.activePeers.has(nodeId)) {
        const peer = this.activePeers.get(nodeId);
        peer.lastSeen = Date.now();
        peer.heartbeats = (peer.heartbeats || 0) + 1;
        
        res.json({ 
          success: true, 
          nextHeartbeat: Date.now() + 120000 // 2 minutes
        });
      } else {
        res.status(404).json({ error: 'Peer not found' });
      }
    });

    // Graceful shutdown
    this.app.post('/unregister', (req, res) => {
      const { nodeId } = req.body;
      if (nodeId && this.activePeers.has(nodeId)) {
        this.removePeer(nodeId);
        res.json({ success: true });
      } else {
        res.json({ success: false, error: 'Peer not found' });
      }
    });

    // Error handling
    this.app.use((error, req, res, next) => {
      console.error('Server error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async handlePeerRegistration(peerData, clientIP) {
    const { peerId, address, port, metadata = {} } = peerData;
    
    if (!peerId || !address) {
      throw new Error('Missing required fields: peerId, address');
    }

    // Classify the peer
    const classification = this.classifyPeer(metadata);
    
    // Create peer record
    const peerRecord = {
      nodeId: peerId,
      address: `${address}:${port || 8080}`,
      clientIP,
      classification,
      metadata: {
        ...metadata,
        userAgent: metadata.userAgent || 'Unknown',
        platform: metadata.deviceInfo?.platform || 'unknown',
        appVersion: metadata.appVersion || 'unknown',
        capabilities: metadata.capabilities || []
      },
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      heartbeats: 0,
      region: this.detectRegion(clientIP)
    };

    // Store peer
    this.activePeers.set(peerId, peerRecord);
    this.addToRegion(peerRecord.region, peerId);
    this.updateStats(classification);

    console.log(`✅ Peer registered: ${classification.appVariant} - ${peerId.substring(0, 8)}...`);

    // Return bootstrap peers
    const bootstrapPeers = this.selectBootstrapPeers(peerId, peerRecord.region, classification);
    
    return {
      success: true,
      nodeId: peerId,
      assignedRegion: peerRecord.region,
      classification,
      peers: bootstrapPeers,
      networkStats: {
        totalPeers: this.activePeers.size,
        ...this.nodeStats
      },
      nextHeartbeat: Date.now() + 120000,
      bootstrapInfo: {
        recommendedPeers: bootstrapPeers.length,
        networkHealth: this.calculateNetworkHealth()
      }
    };
  }

  classifyPeer(metadata) {
    const officialBundleIds = [
      "com.sufiyan.m1.Nexus",
      "com.nexus.mobile.v1"
    ];

    let appVariant = "custom";
    let trustLevel = "untrusted";

    if (officialBundleIds.includes(metadata.bundleId)) {
      appVariant = "official";
      trustLevel = "trusted";
    } else if (metadata.appName?.toLowerCase().includes('nexus')) {
      appVariant = "fork";
      trustLevel = "semi-trusted";
    }

    return {
      appVariant,
      trustLevel,
      appName: metadata.appName || "Unknown",
      appVersion: metadata.appVersion || "Unknown",
      bundleId: metadata.bundleId || "Unknown",
      userAgent: metadata.userAgent || "Unknown",
      isOfficial: appVariant === "official"
    };
  }

  selectBootstrapPeers(requestingPeerId, region, classification) {
    const maxPeers = 10;
    const peers = [];
    
    // Priority 1: Same region, official app peers
    const officialSameRegion = this.getPeersByFilter(p => 
      p.classification.appVariant === 'official' && 
      p.region === region &&
      p.nodeId !== requestingPeerId
    ).slice(0, 4);
    peers.push(...officialSameRegion);

    // Priority 2: Same region, any trusted peers
    if (peers.length < maxPeers) {
      const trustedSameRegion = this.getPeersByFilter(p => 
        p.classification.trustLevel !== 'untrusted' && 
        p.region === region &&
        p.nodeId !== requestingPeerId &&
        !peers.find(existing => existing.nodeId === p.nodeId)
      ).slice(0, maxPeers - peers.length);
      peers.push(...trustedSameRegion);
    }

    // Priority 3: Other regions if needed
    if (peers.length < 3) {
      const globalPeers = this.getPeersByFilter(p => 
        p.nodeId !== requestingPeerId &&
        !peers.find(existing => existing.nodeId === p.nodeId)
      ).slice(0, maxPeers - peers.length);
      peers.push(...globalPeers);
    }

    return peers.map(p => ({
      nodeId: p.nodeId,
      address: p.address,
      classification: p.classification,
      region: p.region,
      lastSeen: p.lastSeen
    }));
  }

  detectRegion(clientIP) {
    // Simple region detection - you can enhance this
    if (clientIP.startsWith('192.168.') || clientIP === '127.0.0.1') {
      return 'local';
    }
    
    // You can integrate with MaxMind GeoIP or similar service
    // For now, use simple heuristics
    const hash = this.simpleHash(clientIP);
    const regions = ['us-east', 'us-west', 'eu-west', 'asia-pacific'];
    return regions[hash % regions.length];
  }

  startCleanupTasks() {
    // Clean up inactive peers every 2 minutes
    setInterval(() => {
      this.cleanupInactivePeers();
    }, 120000);

    // Update statistics every 30 seconds
    setInterval(() => {
      this.recalculateStats();
    }, 30000);

    // Log network status every 5 minutes
    setInterval(() => {
      console.log(`📊 Network Status: ${this.activePeers.size} active peers`);
      console.log(`   Official: ${this.nodeStats.official}, Forks: ${this.nodeStats.forks}, Custom: ${this.nodeStats.custom}`);
    }, 300000);
  }

  // FIXED: Add missing recalculateStats method
  recalculateStats() {
    // Recalculate peer counts by classification
    this.nodeStats.official = 0;
    this.nodeStats.forks = 0;
    this.nodeStats.custom = 0;
    
    for (const peer of this.activePeers.values()) {
      switch (peer.classification.appVariant) {
        case 'official':
          this.nodeStats.official++;
          break;
        case 'fork':
          this.nodeStats.forks++;
          break;
        default:
          this.nodeStats.custom++;
          break;
      }
    }
    
    // Update peak peer count
    this.nodeStats.peakPeers = Math.max(this.nodeStats.peakPeers, this.activePeers.size);
    
    // Log stats periodically
    const now = Date.now();
    if (now - this.lastStatsLog > 300000) { // Every 5 minutes
      console.log(`📊 Stats updated: ${this.activePeers.size} peers (${this.nodeStats.official} official, ${this.nodeStats.forks} forks, ${this.nodeStats.custom} custom)`);
      this.lastStatsLog = now;
    }
  }

  cleanupInactivePeers() {
    const cutoffTime = Date.now() - 300000; // 5 minutes timeout
    let cleaned = 0;
    
    for (const [peerId, peer] of this.activePeers) {
      if (peer.lastSeen < cutoffTime) {
        this.removePeer(peerId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} inactive peers`);
    }
  }

  removePeer(peerId) {
    const peer = this.activePeers.get(peerId);
    if (peer) {
      this.activePeers.delete(peerId);
      this.removeFromRegion(peer.region, peerId);
    }
  }

  // FIXED: Add missing getRegionDistribution method
  getRegionDistribution() {
    const distribution = {};
    for (const [region, peerSet] of this.peersByRegion) {
      distribution[region] = peerSet.size;
    }
    return distribution;
  }

  // FIXED: Add missing getRecentActivity method
  getRecentActivity() {
    const cutoff = Date.now() - 300000; // Last 5 minutes
    return Array.from(this.activePeers.values())
      .filter(peer => peer.registeredAt > cutoff)
      .map(peer => ({
        nodeId: peer.nodeId.substring(0, 8) + '...',
        appVariant: peer.classification.appVariant,
        region: peer.region,
        registeredAt: peer.registeredAt
      }));
  }

  // Utility methods
  getPeersByFilter(filterFn) {
    return Array.from(this.activePeers.values()).filter(filterFn);
  }

  addToRegion(region, peerId) {
    if (!this.peersByRegion.has(region)) {
      this.peersByRegion.set(region, new Set());
    }
    this.peersByRegion.get(region).add(peerId);
  }

  removeFromRegion(region, peerId) {
    if (this.peersByRegion.has(region)) {
      this.peersByRegion.get(region).delete(peerId);
    }
  }

  updateStats(classification) {
    this.nodeStats.totalRegistrations++;
    if (classification.appVariant === 'official') this.nodeStats.official++;
    else if (classification.appVariant === 'fork') this.nodeStats.forks++;
    else this.nodeStats.custom++;
    
    this.nodeStats.peakPeers = Math.max(this.nodeStats.peakPeers, this.activePeers.size);
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return Math.abs(hash);
  }

  getAppVariants() {
    const variants = {};
    for (const peer of this.activePeers.values()) {
      const key = peer.classification.appVariant;
      variants[key] = (variants[key] || 0) + 1;
    }
    return variants;
  }

  calculateNetworkHealth() {
    const totalPeers = this.activePeers.size;
    if (totalPeers === 0) return 0;
    
    const officialRatio = this.nodeStats.official / totalPeers;
    const regionDistribution = this.peersByRegion.size;
    
    // Health score based on peer count, official ratio, and distribution
    return Math.min(100, 
      (totalPeers * 2) + 
      (officialRatio * 30) + 
      (regionDistribution * 5)
    );
  }

  start() {
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`🚀 Nexus Bootstrap Server running on port ${this.port}`);
      console.log(`📡 Ready to bootstrap P2P network`);
    });
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const port = process.env.PORT || 3000;
  const server = new NexusBootstrapServer(port);
  server.start();
}

module.exports = NexusBootstrapServer;
