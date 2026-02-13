// AI Dealer Poker - 主服务器
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

// 配置
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// 初始化
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Redis 客户端（可选，如果没有 Redis 用内存替代）
let redis = null;
let useRedis = false;

try {
  redis = new Redis(REDIS_URL);
  redis.on('error', (err) => {
    console.log('⚠️  Redis 连接失败，使用内存存储');
    useRedis = false;
  });
  redis.on('connect', () => {
    console.log('✅ Redis 已连接');
    useRedis = true;
  });
} catch (err) {
  console.log('⚠️  Redis 不可用，使用内存存储');
  useRedis = false;
}

// 内存存储（Redis 不可用时）
const rooms = new Map();
const players = new Map();
const transactions = new Map();

// 工具函数
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function generateNickname() {
  const prefixes = ['小龙虾', '大鲨鱼', '运气王', '牌神', '赌神', '荷官', '新手', '老司机'];
  const suffix = Math.floor(Math.random() * 10000);
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]} #${suffix}`;
}

async function saveRoom(roomId, data) {
  if (useRedis && redis) {
    await redis.hset(`room:${roomId}`, JSON.stringify(data));
    await redis.expire(`room:${roomId}`, 86400 * 7); // 7天过期
  } else {
    rooms.set(roomId, data);
  }
}

async function getRoom(roomId) {
  if (useRedis && redis) {
    const data = await redis.hgetall(`room:${roomId}`);
    return data ? JSON.parse(data) : null;
  }
  return rooms.get(roomId);
}

async function saveTransaction(roomId, playerId, tx) {
  const txId = uuidv4();
  const txData = {
    id: txId,
    roomId,
    playerId,
    type: tx.type,
    amount: tx.amount,
    note: tx.note || '',
    timestamp: new Date().toISOString()
  };
  
  if (useRedis && redis) {
    await redis.rpush(`tx:${roomId}:${playerId}`, JSON.stringify(txData));
  } else {
    if (!transactions.has(roomId)) transactions.set(roomId, {});
    if (!transactions.get(roomId)[playerId]) {
      transactions.get(roomId)[playerId] = [];
    }
    transactions.get(roomId)[playerId].push(txData);
  }
  
  return txData;
}

async function getTransactions(roomId, playerId) {
  if (useRedis && redis) {
    const txs = await redis.lrange(`tx:${roomId}:${playerId}`, 0, -1);
    return txs.map(tx => JSON.parse(tx));
  }
  return transactions.get(roomId)?.[playerId] || [];
}

// API 路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.post('/api/rooms', (req, res) => {
  const { name, creatorNickname } = req.body;
  const roomId = generateRoomId();
  
  const room = {
    id: roomId,
    name: name || `德州扑克夜 ${new Date().toLocaleDateString()}`,
    status: 'waiting',
    players: [],
    createdAt: new Date().toISOString()
  };
  
  saveRoom(roomId, room);
  
  res.json({
    success: true,
    roomId,
    room
  });
});

app.get('/api/rooms/:roomId', async (req, res) => {
  const room = await getRoom(req.params.roomId);
  
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }
  
  res.json(room);
});

app.get('/api/transactions/:roomId/:playerId', async (req, res) => {
  const { roomId, playerId } = req.params;
  const txs = await getTransactions(roomId, playerId);
  res.json(txs);
});

// WebSocket 处理
io.on('connection', (socket) => {
  console.log('🔗 新连接:', socket.id);
  
  // 加入房间
  socket.on('joinRoom', async (data) => {
    const { roomId, nickname, fluxaAgentId } = data;
    const room = await getRoom(roomId);
    
    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }
    
    if (room.status !== 'waiting' && room.status !== 'playing') {
      socket.emit('error', { message: '房间已结束' });
      return;
    }
    
    // 创建玩家
    const player = {
      id: uuidv4(),
      socketId: socket.id,
      nickname: nickname || generateNickname(),
      fluxaAgentId: fluxaAgentId || null,
      buyin: 0,
      finalChips: null,
      profit: 0,
      joinedAt: new Date().toISOString()
    };
    
    room.players.push(player);
    await saveRoom(roomId, room);
    
    socket.join(roomId);
    socket.playerId = player.id;
    socket.roomId = roomId;
    
    // 广播给房间内所有人
    io.to(roomId).emit('playerJoined', {
      player,
      players: room.players
    });
    
    console.log(`👤 ${player.nickname} 加入房间 ${roomId}`);
  });
  
  // 买入筹码
  socket.on('buyin', async (data) => {
    const { roomId, playerId, amount, note } = data;
    const room = await getRoom(roomId);
    
    if (!room) return;
    
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    
    // 更新玩家买入
    player.buyin = (player.buyin || 0) + amount;
    await saveRoom(roomId, room);
    
    // 记录交易
    await saveTransaction(roomId, playerId, {
      type: 'buyin',
      amount,
      note: note || `买入 ${amount}`
    });
    
    // 广播
    io.to(roomId).emit('buyin', {
      playerId,
      player,
      amount,
      note
    });
    
    console.log(`💰 ${player.nickname} 买入 ${amount}`);
  });
  
  // 记录输赢
  socket.on('recordResult', async (data) => {
    const { roomId, playerId, type, amount, note } = data;
    const room = await getRoom(roomId);
    
    if (!room) return;
    
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    
    // 记录交易
    await saveTransaction(roomId, playerId, {
      type,
      amount,
      note: note || (type === 'win' ? `赢得 ${amount}` : `输掉 ${amount}`)
    });
    
    // 广播
    io.to(roomId).emit('recordResult', {
      playerId,
      player,
      type,
      amount,
      note
    });
    
    console.log(`🎯 ${player.nickname} ${type} ${amount}`);
  });
  
  // 结束牌局，录入剩余筹码
  socket.on('finalizeRoom', async (data) => {
    const { roomId, finalChips } = data;
    const room = await getRoom(roomId);
    
    if (!room) return;
    
    // 更新每个玩家的剩余筹码
    for (const fc of finalChips) {
      const player = room.players.find(p => p.id === fc.playerId);
      if (player) {
        player.finalChips = fc.amount;
        player.profit = fc.amount - player.buyin;
      }
    }
    
    room.status = 'ended';
    room.finalChips = finalChips;
    room.endedAt = new Date().toISOString();
    
    await saveRoom(roomId, room);
    
    // 广播结束
    io.to(roomId).emit('roomEnded', {
      room,
      summary: room.players.map(p => ({
        nickname: p.nickname,
        buyin: p.buyin,
        finalChips: p.finalChips,
        profit: p.profit
      }))
    });
    
    console.log(`🏁 房间 ${roomId} 已结束`);
  });
  
  // 离开房间
  socket.on('leaveRoom', () => {
    const { roomId, playerId } = socket;
    if (roomId && playerId) {
      socket.leave(roomId);
      console.log(`👋 玩家离开房间 ${roomId}`);
    }
  });
  
  // 断开连接
  socket.on('disconnect', () => {
    console.log('❌ 断开连接:', socket.id);
  });
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`
🎰 AI Dealer Poker 服务器启动
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📡 端口: ${PORT}
💾 存储: ${useRedis ? 'Redis' : '内存'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
});

module.exports = { app, server, io };
