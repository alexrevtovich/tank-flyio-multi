const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── Config ──
const PORT = process.env.PORT || 8080;

// ── Room ID generation ──
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(len) {
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

function generateRoomId() {
  for (let i = 0; i < 100; i++) {
    const id = generateCode(4);
    if (!rooms.has(id)) return id;
  }
  return generateCode(6);
}

// ── Player colors (up to 8) ──
const PLAYER_COLORS = [
  '#FF4444', '#4488FF', '#44DD44', '#DDDD44',
  '#AA44FF', '#FF8844', '#44DDDD', '#FF44AA'
];

// ── Game constants ──
const RADIUS = 20;
const SPEED = 3;
const CANVAS_W = 1800;
const CANVAS_H = 1000;
const PROJECTILE_SPEED = 6;
const PROJECTILE_RADIUS = 4;
const FIRE_COOLDOWN = 1000;
const MAX_HP = 100;
const BULLET_DAMAGE = 50;
const DESTRUCT_COUNT = 24;
const DESTRUCT_RADIUS = 25;
const ARMOUR_FRONT = 10;
const ARMOUR_SIDE = 5;
const ARMOUR_REAR = 0;
const HEAL_PER_SEC = 1;
const HEAL_DURATION = 10000;
const HEAL_COOLDOWN = 3000;
const PICKUP_RADIUS = 15;
const PICKUP_INTERVAL = 20000;
const PICKUP_TYPES = ['speed', 'armour', 'heal'];

// ── Rooms ──
const rooms = new Map();

function createRoom(roomId) {
  const room = {
    id: roomId,
    gameScreens: [],
    gameRunning: false,
    playerCount: 2,
    players: [],
    inputState: {},
    facing: {},
    projectiles: {},
    lastFireTime: {},
    healState: {},
    botPlayerIds: new Set(),
    botState: {},
    readyState: {},
    pickups: [],
    playerPickups: {},
    lastPickupSpawnTime: 0,
    nextPickupTypeIndex: 0,
    pickupIdCounter: 0,
    walls: [],
    destructibles: [],
    bgSeed: 0,
    gameLoopInterval: null,
    gameStartTime: 0,
    frameShotsFired: [],
    ownerWs: null
  };
  initPlayers(room, 2);
  room.walls = generateWalls();
  room.destructibles = generateDestructibles();
  room.bgSeed = 1 + Math.floor(Math.random() * 999999);
  rooms.set(roomId, room);
  console.log(`Room ${roomId} created. Active rooms: ${rooms.size}`);
  return room;
}

function checkRoomCleanup(room) {
  const hasGameScreens = room.gameScreens.length > 0;
  const hasPlayers = room.players.some(p => p.connected && !p.isBot);
  if (!hasGameScreens && !hasPlayers) {
    if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
    rooms.delete(room.id);
    console.log(`Room ${room.id} destroyed. Active rooms: ${rooms.size}`);
  }
}

// ── Spawn positions ──
function getSpawnPositions(count) {
  const positions = [];
  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;
  const spawnRadius = Math.min(CANVAS_W, CANVAS_H) * 0.35;
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    positions.push({
      x: Math.round(cx + Math.cos(angle) * spawnRadius),
      y: Math.round(cy + Math.sin(angle) * spawnRadius)
    });
  }
  return positions;
}

function initPlayers(room, count) {
  room.playerCount = count;
  const positions = getSpawnPositions(count);
  room.players = [];
  room.inputState = {};
  room.facing = {};
  room.projectiles = {};
  room.lastFireTime = {};

  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const isBot = room.botPlayerIds.has(id);
    room.players.push({
      id,
      code: isBot ? 'BOT' : String(id),
      ws: null,
      connected: isBot ? true : false,
      isBot,
      name: isBot ? 'Bot' + id : 'P' + id,
      x: positions[i].x,
      y: positions[i].y,
      score: 0,
      hp: MAX_HP,
      alive: true
    });
    room.inputState[id] = { x: 0, y: 0 };
    room.facing[id] = { dx: 0, dy: -1 };
    room.projectiles[id] = null;
    room.lastFireTime[id] = 0;
    room.healState[id] = { active: false, startTime: 0, lastTick: 0, endTime: 0 };
    if (isBot) {
      room.botState[id] = { avoidUntil: 0, avoidDirX: 0, avoidDirY: 0, lastX: positions[i].x, lastY: positions[i].y, stuckFrames: 0 };
    }
  }
  room.botPlayerIds = new Set([...room.botPlayerIds].filter(id => id <= count));
  room.playerPickups = {};
  for (let i = 0; i < count; i++) {
    room.playerPickups[i + 1] = { speed: false, armour: false, heal: false };
  }
}

// ── Wall obstacles ──
function generateWalls() {
  const walls = [];
  for (let i = 0; i < 10; i++) {
    const w = 10 + Math.floor(Math.random() * 11);
    const h = 20 + Math.floor(Math.random() * 61);
    const x = 100 + Math.floor(Math.random() * (CANVAS_W - 200));
    const y = 100 + Math.floor(Math.random() * (CANVAS_H - 200));
    const angle = Math.random() < 0.5 ? 0 : Math.PI / 2;
    walls.push({ x, y, w, h, angle });
  }
  return walls;
}

function toWallLocal(wx, wy, wall) {
  const cx = wall.x;
  const cy = wall.y;
  const dx = wx - cx;
  const dy = wy - cy;
  const cos = Math.cos(-wall.angle);
  const sin = Math.sin(-wall.angle);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

// ── Destructible rock formations ──
function generateDestructibles() {
  const objs = [];
  for (let i = 0; i < DESTRUCT_COUNT; i++) {
    const w = 40 + Math.floor(Math.random() * 41);
    const h = 40 + Math.floor(Math.random() * 41);
    const x = 120 + Math.floor(Math.random() * (CANVAS_W - 240));
    const y = 120 + Math.floor(Math.random() * (CANVAS_H - 240));
    objs.push({ id: i, x, y, w, h, holes: [] });
  }
  return objs;
}

function isDestructibleSolid(obj, px, py) {
  const hw = obj.w / 2, hh = obj.h / 2;
  if (px < obj.x - hw || px > obj.x + hw ||
      py < obj.y - hh || py > obj.y + hh) return false;
  for (const hole of obj.holes) {
    const dx = px - hole.cx, dy = py - hole.cy;
    if (dx * dx + dy * dy <= hole.r * hole.r) return false;
  }
  return true;
}

// ── HTTP Server ──
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json',
  '.mp3':  'audio/mpeg'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/api/rooms') {
    const data = [];
    for (const [id, room] of rooms) {
      const players = room.players.map(p => ({
        id: p.id, name: p.name, connected: p.connected, isBot: p.isBot || false
      }));
      data.push({
        id,
        gameRunning: room.gameRunning,
        playerCount: room.playerCount,
        screens: room.gameScreens.length,
        players
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, 'public', urlPath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

// ── Helper: send init state to game screens ──
function sendInitToGame(room) {
  sendToGame(room, {
    type: 'init',
    roomId: room.id,
    players: room.players.map(p => ({
      id: p.id, code: p.code, connected: p.connected, score: p.score, isBot: p.isBot || false, name: p.name
    })),
    walls: room.walls, destructibles: room.destructibles, bgSeed: room.bgSeed,
    colors: PLAYER_COLORS
  });
}

// ── WebSocket Handler ──
function handleWSConnection(ws) {
  let assignedRole = null;
  let assignedRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'register_game': {
        let roomId = msg.roomId || null;
        let room;
        let isNewRoom = false;
        if (roomId && rooms.has(roomId)) {
          room = rooms.get(roomId);
        } else if (roomId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          break;
        } else {
          roomId = generateRoomId();
          room = createRoom(roomId);
          isNewRoom = true;
        }
        room.gameScreens.push(ws);
        if (isNewRoom) room.ownerWs = ws;
        assignedRole = 'game';
        assignedRoom = room;
        ws.send(JSON.stringify({ type: 'room_joined', roomId: room.id, isOwner: ws === room.ownerWs }));
        sendInitToOneGame(room, ws);
        if (room.gameRunning) {
          sendToOneGame(ws, {
            type: 'game_start',
            walls: room.walls, destructibles: room.destructibles, bgSeed: room.bgSeed,
            keepScores: true
          });
        }
        console.log(`Game screen joined room ${room.id} (${room.gameScreens.length} screens)`);
        break;
      }

      case 'set_player_count': {
        if (!assignedRoom || assignedRole !== 'game') break;
        if (ws !== assignedRoom.ownerWs) break;
        const room = assignedRoom;
        const count = Math.max(2, Math.min(7, parseInt(msg.count) || 2));
        if (!room.gameRunning) {
          room.botPlayerIds = new Set([...room.botPlayerIds].filter(id => id <= count));
          initPlayers(room, count);
          room.walls = generateWalls();
          room.destructibles = generateDestructibles();
          room.bgSeed = 1 + Math.floor(Math.random() * 999999);
          sendInitToGame(room);
          console.log(`Room ${room.id}: Player count set to ${count}`);
        }
        break;
      }

      case 'add_bot': {
        if (!assignedRoom || assignedRole !== 'game') break;
        if (ws !== assignedRoom.ownerWs) break;
        const room = assignedRoom;
        if (room.gameRunning) break;
        if (room.playerCount >= 7) break;
        const newCount = room.playerCount + 1;
        const botId = newCount;
        const savedHumans = room.players.filter(p => !p.isBot && p.connected).map(p => ({
          id: p.id, ws: p.ws, score: p.score, name: p.name
        }));
        room.botPlayerIds.add(botId);
        initPlayers(room, newCount);
        for (const h of savedHumans) {
          if (h.id <= newCount) {
            room.players[h.id - 1].ws = h.ws;
            room.players[h.id - 1].connected = true;
            room.players[h.id - 1].score = h.score;
            room.players[h.id - 1].name = h.name;
          }
        }
        room.walls = generateWalls();
        room.destructibles = generateDestructibles();
        room.bgSeed = 1 + Math.floor(Math.random() * 999999);
        sendInitToGame(room);
        console.log(`Room ${room.id}: Bot added as Player ${botId}. Total: ${newCount}`);
        break;
      }

      case 'remove_bot': {
        if (!assignedRoom || assignedRole !== 'game') break;
        if (ws !== assignedRoom.ownerWs) break;
        const room = assignedRoom;
        if (room.gameRunning) break;
        if (room.botPlayerIds.size === 0) break;
        const botIds = [...room.botPlayerIds].sort((a, b) => b - a);
        const removedId = botIds[0];
        room.botPlayerIds.delete(removedId);
        let newCount = room.playerCount;
        if (removedId === room.playerCount) {
          newCount = room.playerCount - 1;
          if (newCount < 2) newCount = 2;
        }
        const savedHumans2 = room.players.filter(p => !p.isBot && p.connected).map(p => ({
          id: p.id, ws: p.ws, score: p.score, name: p.name
        }));
        initPlayers(room, newCount);
        for (const h of savedHumans2) {
          if (h.id <= newCount) {
            room.players[h.id - 1].ws = h.ws;
            room.players[h.id - 1].connected = true;
            room.players[h.id - 1].score = h.score;
            room.players[h.id - 1].name = h.name;
          }
        }
        room.walls = generateWalls();
        room.destructibles = generateDestructibles();
        room.bgSeed = 1 + Math.floor(Math.random() * 999999);
        sendInitToGame(room);
        console.log(`Room ${room.id}: Bot removed. Total: ${newCount}, Bots: ${room.botPlayerIds.size}`);
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase().trim();
        const roomId = (msg.roomId || '').toUpperCase().trim();

        let room = null;
        if (roomId && rooms.has(roomId)) {
          room = rooms.get(roomId);
        } else {
          for (const [, r] of rooms) {
            if (r.players.find(p => p.code === code)) {
              room = r;
              break;
            }
          }
        }

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
          return;
        }

        const player = room.players.find(p => p.code === code);
        if (!player) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid code' }));
          return;
        }
        if (player.ws && player.ws !== ws) {
          try { player.ws.close(); } catch {}
        }
        player.ws = ws;
        player.connected = true;
        assignedRole = player.id;
        assignedRoom = room;

        const rawName = (msg.name || '').trim().substring(0, 5);
        if (rawName.length > 0) player.name = rawName;

        ws.send(JSON.stringify({
          type: 'welcome',
          playerId: player.id,
          color: PLAYER_COLORS[player.id - 1],
          name: player.name
        }));

        sendToGame(room, { type: 'player_joined', playerId: player.id, name: player.name });
        console.log(`Room ${room.id}: Player ${player.id} (${player.name}) joined with code ${code}`);

        if (room.players.every(p => p.connected) && !room.gameRunning) {
          startGame(room);
        }
        break;
      }

      case 'joystick':
        if (typeof assignedRole === 'number' && assignedRoom && assignedRoom.inputState[assignedRole]) {
          const x = typeof msg.x === 'number' ? Math.max(-1, Math.min(1, msg.x)) : 0;
          const y = typeof msg.y === 'number' ? Math.max(-1, Math.min(1, msg.y)) : 0;
          assignedRoom.inputState[assignedRole].x = x;
          assignedRoom.inputState[assignedRole].y = y;
        }
        break;

      case 'shoot':
        if (typeof assignedRole === 'number' && assignedRoom && assignedRoom.gameRunning) {
          tryShoot(assignedRoom, assignedRole);
        }
        break;

      case 'heal':
        if (typeof assignedRole === 'number' && assignedRoom && assignedRoom.gameRunning) {
          const room = assignedRoom;
          const healer = room.players[assignedRole - 1];
          const hs = room.healState[assignedRole];
          if (healer && healer.alive && !hs.active) {
            const now = Date.now();
            const repairBonus = (room.playerPickups[assignedRole] && room.playerPickups[assignedRole].heal) ? 3000 : 0;
            if (now - hs.endTime >= HEAL_COOLDOWN - repairBonus) {
              hs.active = true;
              hs.startTime = now;
              hs.lastTick = now;
              console.log(`Room ${room.id}: Player ${assignedRole} started healing`);
              sendToPlayer(room, assignedRole, { type: 'feedback', action: 'heal_confirm' });
            }
          }
        }
        break;

      case 'restart_game':
        if (assignedRole === 'game' && assignedRoom && !assignedRoom.gameRunning && assignedRoom.players.every(p => p.connected)) {
          restartRound(assignedRoom);
        }
        break;

      case 'ready':
        if (typeof assignedRole === 'number' && assignedRoom && !assignedRoom.gameRunning) {
          const room = assignedRoom;
          room.readyState[assignedRole] = true;
          console.log(`Room ${room.id}: Player ${assignedRole} is ready`);
          sendToGame(room, { type: 'ready_update', readyState: room.readyState });
          const allReady = room.players.every(p => room.readyState[p.id]);
          if (allReady) {
            console.log(`Room ${room.id}: All players ready — starting next round`);
            restartRound(room);
          }
        }
        break;

      case 'unready':
        if (typeof assignedRole === 'number' && assignedRoom && !assignedRoom.gameRunning) {
          const room = assignedRoom;
          room.readyState[assignedRole] = false;
          console.log(`Room ${room.id}: Player ${assignedRole} is not ready`);
          sendToGame(room, { type: 'ready_update', readyState: room.readyState });
        }
        break;
    }
  });

  ws.on('close', () => {
    if (!assignedRoom) return;
    const room = assignedRoom;

    if (assignedRole === 'game') {
      const idx = room.gameScreens.indexOf(ws);
      if (idx !== -1) room.gameScreens.splice(idx, 1);
      if (ws === room.ownerWs) {
        room.ownerWs = room.gameScreens[0] || null;
        if (room.ownerWs) {
          room.ownerWs.send(JSON.stringify({ type: 'owner_transfer' }));
          console.log(`Room ${room.id}: Ownership transferred`);
        }
      }
      console.log(`Room ${room.id}: Game screen disconnected (${room.gameScreens.length} remaining)`);
    } else if (typeof assignedRole === 'number') {
      const player = room.players[assignedRole - 1];
      if (player) {
        player.connected = false;
        player.ws = null;
        room.inputState[assignedRole] = { x: 0, y: 0 };
        sendToGame(room, { type: 'player_left', playerId: assignedRole });
        console.log(`Room ${room.id}: Player ${assignedRole} disconnected`);

        if (room.gameRunning) {
          pauseGame(room);
        }
      }
    }

    checkRoomCleanup(room);
  });
}

// ── WebSocket Server ──
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  handleWSConnection(ws);
});

// ── Projectile Logic ──
function tryShoot(room, playerId) {
  if (room.projectiles[playerId] !== null) return;

  const p = room.players[playerId - 1];
  if (!p || !p.alive) return;

  const now = Date.now();
  const cooldown = p.isBot ? FIRE_COOLDOWN * 2 : FIRE_COOLDOWN;
  if (now - room.lastFireTime[playerId] < cooldown) return;
  const dir = room.facing[playerId];

  if (dir.dx === 0 && dir.dy === 0) return;

  room.lastFireTime[playerId] = now;

  room.projectiles[playerId] = {
    x: p.x + dir.dx * (RADIUS + PROJECTILE_RADIUS + 2),
    y: p.y + dir.dy * (RADIUS + PROJECTILE_RADIUS + 2),
    dx: dir.dx * PROJECTILE_SPEED,
    dy: dir.dy * PROJECTILE_SPEED,
    ownerId: playerId,
    lastRicochetId: null
  };

  room.frameShotsFired.push(playerId);

  sendToPlayer(room, playerId, { type: 'shot_fired' });
}

// ── Game Loop ──
function resetRound(room, resetScores) {
  const positions = getSpawnPositions(room.playerCount);
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].x = positions[i].x;
    room.players[i].y = positions[i].y;
    if (resetScores) room.players[i].score = 0;
    room.players[i].hp = MAX_HP;
    room.players[i].alive = true;
    const id = room.players[i].id;
    room.inputState[id] = { x: 0, y: 0 };
    room.facing[id] = { dx: 0, dy: -1 };
    room.projectiles[id] = null;
    room.lastFireTime[id] = 0;
    room.healState[id] = { active: false, startTime: 0, lastTick: 0, endTime: 0 };
    if (room.players[i].isBot) {
      room.botState[id] = { avoidUntil: 0, avoidDirX: 0, avoidDirY: 0, lastX: positions[i].x, lastY: positions[i].y, stuckFrames: 0 };
    }
  }
  room.walls = generateWalls();
  room.destructibles = generateDestructibles();
  room.bgSeed = 1 + Math.floor(Math.random() * 999999);
  room.pickups = [];
  room.lastPickupSpawnTime = 0;
  room.nextPickupTypeIndex = 0;
  room.pickupIdCounter = 0;
  for (const p of room.players) {
    room.playerPickups[p.id] = { speed: false, armour: false, heal: false };
  }
}

function startGame(room) {
  room.gameRunning = true;
  room.gameStartTime = Date.now();
  resetRound(room, true);

  sendToGame(room, { type: 'game_start', walls: room.walls, destructibles: room.destructibles, bgSeed: room.bgSeed });
  for (const p of room.players) {
    sendToPlayer(room, p.id, { type: 'game_state', state: 'playing' });
  }

  console.log(`Room ${room.id}: Game started!`);

  if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
  room.gameLoopInterval = setInterval(() => gameLoop(room), 1000 / 45);
}

function restartRound(room) {
  room.gameRunning = true;
  room.gameStartTime = Date.now();
  resetRound(room, false);

  sendToGame(room, { type: 'game_start', walls: room.walls, destructibles: room.destructibles, bgSeed: room.bgSeed, keepScores: true });
  for (const p of room.players) {
    sendToPlayer(room, p.id, { type: 'game_state', state: 'playing' });
  }

  console.log(`Room ${room.id}: Round restarted!`);

  if (room.gameLoopInterval) clearInterval(room.gameLoopInterval);
  room.gameLoopInterval = setInterval(() => gameLoop(room), 1000 / 45);
}

function pauseGame(room) {
  room.gameRunning = false;
  if (room.gameLoopInterval) {
    clearInterval(room.gameLoopInterval);
    room.gameLoopInterval = null;
  }
  sendToGame(room, { type: 'game_paused' });
  console.log(`Room ${room.id}: Game paused — waiting for reconnect`);
}

function updateBotAI(room) {
  const now = Date.now();
  if (now - room.gameStartTime < 2000) return;
  for (const p of room.players) {
    if (!p.isBot || !p.alive) continue;
    const id = p.id;
    const state = room.botState[id];
    if (!state) continue;

    let closestDist = Infinity;
    let closestPlayer = null;
    for (const other of room.players) {
      if (other.id === id || !other.alive) continue;
      const dx = other.x - p.x;
      const dy = other.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestPlayer = other;
      }
    }

    if (!closestPlayer) {
      room.inputState[id] = { x: 0, y: 0 };
      continue;
    }

    tryShoot(room, id);

    const movedDx = p.x - state.lastX;
    const movedDy = p.y - state.lastY;
    const movedDist = Math.sqrt(movedDx * movedDx + movedDy * movedDy);
    const hadInput = Math.abs(room.inputState[id].x) > 0.1 || Math.abs(room.inputState[id].y) > 0.1;
    if (hadInput && movedDist < 0.5) {
      state.stuckFrames++;
    } else {
      state.stuckFrames = 0;
    }
    state.lastX = p.x;
    state.lastY = p.y;

    if (state.stuckFrames > 10 && now >= state.avoidUntil) {
      const curDx = room.inputState[id].x;
      const curDy = room.inputState[id].y;
      const turnRight = Math.random() < 0.5;
      if (turnRight) {
        state.avoidDirX = -curDy;
        state.avoidDirY = curDx;
      } else {
        state.avoidDirX = curDy;
        state.avoidDirY = -curDx;
      }
      const avoidLen = Math.sqrt(state.avoidDirX * state.avoidDirX + state.avoidDirY * state.avoidDirY);
      if (avoidLen > 0) {
        state.avoidDirX /= avoidLen;
        state.avoidDirY /= avoidLen;
      } else {
        const angle = Math.random() * Math.PI * 2;
        state.avoidDirX = Math.cos(angle);
        state.avoidDirY = Math.sin(angle);
      }
      state.avoidUntil = now + 2000;
      state.stuckFrames = 0;
    }

    let movX, movY;
    if (now < state.avoidUntil) {
      movX = state.avoidDirX;
      movY = state.avoidDirY;
    } else {
      const moveDx2 = closestPlayer.x - p.x;
      const moveDy2 = closestPlayer.y - p.y;
      const moveLen = Math.sqrt(moveDx2 * moveDx2 + moveDy2 * moveDy2);
      if (moveLen > 0) {
        movX = moveDx2 / moveLen;
        movY = moveDy2 / moveLen;
      } else {
        movX = 0; movY = 0;
      }
    }
    room.inputState[id] = { x: movX, y: movY };
    if (Math.abs(movX) > 0.01 || Math.abs(movY) > 0.01) {
      const fLen = Math.sqrt(movX * movX + movY * movY);
      room.facing[id] = { dx: movX / fLen, dy: movY / fLen };
    }
  }
}

function spawnPickup(room) {
  if (room.pickups.length > 0) return;
  const now = Date.now();
  if (room.lastPickupSpawnTime === 0) room.lastPickupSpawnTime = room.gameStartTime;
  if (now - room.lastPickupSpawnTime < PICKUP_INTERVAL) return;

  const alivePlayers = room.players.filter(p => p.alive);
  if (alivePlayers.length < 2) return;

  let cx = 0, cy = 0;
  for (const p of alivePlayers) { cx += p.x; cy += p.y; }
  cx /= alivePlayers.length;
  cy /= alivePlayers.length;

  let bestX = cx, bestY = cy, bestMinDist = 0;
  const candidates = [{ x: cx, y: cy }];
  for (let a = 0; a < 8; a++) {
    const angle = (Math.PI * 2 * a) / 8;
    for (const r of [100, 200, 300]) {
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (px > 30 && px < CANVAS_W - 30 && py > 30 && py < CANVAS_H - 30) {
        candidates.push({ x: px, y: py });
      }
    }
  }

  for (const cand of candidates) {
    let minDist = Infinity;
    for (const p of alivePlayers) {
      const dx = cand.x - p.x, dy = cand.y - p.y;
      minDist = Math.min(minDist, Math.sqrt(dx * dx + dy * dy));
    }
    let blocked = false;
    for (const wall of room.walls) {
      const local = toWallLocal(cand.x, cand.y, wall);
      if (Math.abs(local.x) < wall.w / 2 + PICKUP_RADIUS && Math.abs(local.y) < wall.h / 2 + PICKUP_RADIUS) {
        blocked = true; break;
      }
    }
    if (!blocked && minDist > bestMinDist) {
      bestMinDist = minDist;
      bestX = cand.x;
      bestY = cand.y;
    }
  }

  const type = PICKUP_TYPES[room.nextPickupTypeIndex % PICKUP_TYPES.length];
  room.nextPickupTypeIndex++;
  room.pickupIdCounter++;
  room.pickups.push({ id: room.pickupIdCounter, type, x: Math.round(bestX), y: Math.round(bestY) });
  room.lastPickupSpawnTime = now;
  console.log(`Room ${room.id}: Spawned ${type} pickup at (${Math.round(bestX)}, ${Math.round(bestY)})`);
}

function checkPickupCollisions(room) {
  for (let i = room.pickups.length - 1; i >= 0; i--) {
    const pickup = room.pickups[i];
    for (const p of room.players) {
      if (!p.alive) continue;
      const dx = p.x - pickup.x, dy = p.y - pickup.y;
      if (Math.sqrt(dx * dx + dy * dy) < RADIUS + PICKUP_RADIUS) {
        if (room.playerPickups[p.id][pickup.type]) continue;
        room.playerPickups[p.id][pickup.type] = true;
        room.pickups.splice(i, 1);
        console.log(`Room ${room.id}: Player ${p.id} picked up ${pickup.type}`);
        sendToPlayer(room, p.id, { type: 'feedback', action: 'pickup', pickupType: pickup.type });
        sendToGame(room, { type: 'pickup_collected', playerId: p.id, pickupType: pickup.type, pickupId: pickup.id });
        break;
      }
    }
  }
}

function gameLoop(room) {
  updateBotAI(room);

  for (const p of room.players) {
    if (!p.alive) continue;
    const input = room.inputState[p.id];
    const speedMult = (room.playerPickups[p.id] && room.playerPickups[p.id].speed) ? 1.3 : 1.0;
    const spd = (p.isBot ? 1.8 : SPEED) * speedMult;
    let dx = input.x * spd;
    let dy = input.y * spd;

    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > spd) {
      dx = (dx / mag) * spd;
      dy = (dy / mag) * spd;
    }

    if (!p.isBot && (Math.abs(input.x) > 0.01 || Math.abs(input.y) > 0.01)) {
      const len = Math.sqrt(input.x * input.x + input.y * input.y);
      room.facing[p.id] = { dx: input.x / len, dy: input.y / len };
    }

    p.x = Math.max(RADIUS, Math.min(CANVAS_W - RADIUS, p.x + dx));
    p.y = Math.max(RADIUS, Math.min(CANVAS_H - RADIUS, p.y + dy));

    for (const wall of room.walls) {
      const hw = wall.w / 2, hh = wall.h / 2;
      const local = toWallLocal(p.x, p.y, wall);
      const clX = Math.max(-hw, Math.min(hw, local.x));
      const clY = Math.max(-hh, Math.min(hh, local.y));
      const dlx = local.x - clX;
      const dly = local.y - clY;
      const distSq = dlx * dlx + dly * dly;
      if (distSq < RADIUS * RADIUS && distSq > 0) {
        const dist = Math.sqrt(distSq);
        const plx = (dlx / dist) * (RADIUS - dist);
        const ply = (dly / dist) * (RADIUS - dist);
        const cos = Math.cos(wall.angle);
        const sin = Math.sin(wall.angle);
        p.x += plx * cos - ply * sin;
        p.y += plx * sin + ply * cos;
        p.x = Math.max(RADIUS, Math.min(CANVAS_W - RADIUS, p.x));
        p.y = Math.max(RADIUS, Math.min(CANVAS_H - RADIUS, p.y));
      }
    }

    for (const obj of room.destructibles) {
      const hw = obj.w / 2, hh = obj.h / 2;
      const clX = Math.max(obj.x - hw, Math.min(obj.x + hw, p.x));
      const clY = Math.max(obj.y - hh, Math.min(obj.y + hh, p.y));
      const dlx = p.x - clX;
      const dly = p.y - clY;
      const distSq = dlx * dlx + dly * dly;
      if (distSq < RADIUS * RADIUS && distSq > 0) {
        let inHole = false;
        for (const hole of obj.holes) {
          const hdx = clX - hole.cx, hdy = clY - hole.cy;
          if (hdx * hdx + hdy * hdy <= hole.r * hole.r) { inHole = true; break; }
        }
        if (inHole) continue;
        const dist = Math.sqrt(distSq);
        p.x += (dlx / dist) * (RADIUS - dist);
        p.y += (dly / dist) * (RADIUS - dist);
        p.x = Math.max(RADIUS, Math.min(CANVAS_W - RADIUS, p.x));
        p.y = Math.max(RADIUS, Math.min(CANVAS_H - RADIUS, p.y));
      }
    }
  }

  for (let i = 0; i < room.players.length; i++) {
    for (let j = i + 1; j < room.players.length; j++) {
      const a = room.players[i];
      const b = room.players[j];
      if (!a.alive || !b.alive) continue;
      const dx_t = b.x - a.x;
      const dy_t = b.y - a.y;
      const dist_t = Math.sqrt(dx_t * dx_t + dy_t * dy_t);
      const minDist = RADIUS * 2;
      if (dist_t < minDist && dist_t > 0) {
        const overlap = (minDist - dist_t) / 2;
        const nx = dx_t / dist_t;
        const ny = dy_t / dist_t;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        a.x = Math.max(RADIUS, Math.min(CANVAS_W - RADIUS, a.x));
        a.y = Math.max(RADIUS, Math.min(CANVAS_H - RADIUS, a.y));
        b.x = Math.max(RADIUS, Math.min(CANVAS_W - RADIUS, b.x));
        b.y = Math.max(RADIUS, Math.min(CANVAS_H - RADIUS, b.y));
      }
    }
  }

  spawnPickup(room);
  checkPickupCollisions(room);

  const healNow = Date.now();
  for (const p of room.players) {
    if (!p.alive) continue;
    const hs = room.healState[p.id];
    if (!hs.active) continue;
    if (healNow - hs.startTime >= HEAL_DURATION) {
      hs.active = false;
      hs.endTime = healNow;
      continue;
    }
    if (healNow - hs.lastTick >= 1000) {
      hs.lastTick = healNow;
      p.hp = Math.min(MAX_HP, p.hp + HEAL_PER_SEC);
    }
    if (p.hp >= MAX_HP) {
      hs.active = false;
      hs.endTime = healNow;
    }
  }

  const frameHits = [];
  const frameDestructHits = [];
  for (const p of room.players) {
    const id = p.id;
    const proj = room.projectiles[id];
    if (!proj) continue;

    proj.x += proj.dx;
    proj.y += proj.dy;

    if (proj.x < 0 || proj.x > CANVAS_W || proj.y < 0 || proj.y > CANVAS_H) {
      frameHits.push({
        x: Math.round(Math.max(0, Math.min(CANVAS_W, proj.x))),
        y: Math.round(Math.max(0, Math.min(CANVAS_H, proj.y))),
        hitType: 'wall'
      });
      room.projectiles[id] = null;
      continue;
    }

    let hitWall = false;
    for (const wall of room.walls) {
      const hw = wall.w / 2, hh = wall.h / 2;
      const local = toWallLocal(proj.x, proj.y, wall);
      if (local.x >= -hw && local.x <= hw && local.y >= -hh && local.y <= hh) {
        frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'wall' });
        room.projectiles[id] = null;
        hitWall = true;
        break;
      }
    }
    if (hitWall) continue;

    let hitDestruct = false;
    for (const obj of room.destructibles) {
      if (isDestructibleSolid(obj, proj.x, proj.y)) {
        const cx = Math.round(proj.x), cy = Math.round(proj.y);
        obj.holes.push({ cx, cy, r: DESTRUCT_RADIUS });
        frameHits.push({ x: cx, y: cy, hitType: 'wall' });
        frameDestructHits.push({ x: cx, y: cy, r: DESTRUCT_RADIUS });
        room.projectiles[id] = null;
        hitDestruct = true;
        break;
      }
    }
    if (hitDestruct) continue;

    let hitPlayer = false;
    let ricocheted = false;
    for (const target of room.players) {
      if (target.id === id || !target.alive) continue;
      if (target.id === proj.lastRicochetId) continue;
      const dx = proj.x - target.x;
      const dy = proj.y - target.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < RADIUS + PROJECTILE_RADIUS) {
        // Check angle of incidence for ricochet
        const tFace = room.facing[target.id];
        const projAngle = Math.atan2(proj.dy, proj.dx);
        const faceAngle = Math.atan2(tFace.dy, tFace.dx);
        let relAngle = Math.abs(projAngle - faceAngle);
        if (relAngle > Math.PI) relAngle = 2 * Math.PI - relAngle;

        // Surface normal at impact (from tank center to projectile)
        const nLen = dist > 0 ? dist : 1;
        const nx = dx / nLen, ny = dy / nLen;
        // Incoming direction (reversed projectile velocity)
        const projSpeed = Math.sqrt(proj.dx * proj.dx + proj.dy * proj.dy);
        if (projSpeed < 0.01) { /* dead projectile */ room.projectiles[id] = null; hitPlayer = true; break; }
        const inX = -proj.dx / projSpeed, inY = -proj.dy / projSpeed;
        // Angle of incidence: angle between incoming dir and surface normal
        const cosAngle = nx * inX + ny * inY;

        // Ricochet: angle > 50° from normal (< 40° from surface), but NOT rear hits
        const isRear = relAngle <= Math.PI * 0.25;
        if (!isRear && cosAngle < 0.6428) { // cos(50°) ≈ 0.6428
          // Ricochet — reflect projectile off surface normal
          const dot2 = 2 * (proj.dx * nx + proj.dy * ny);
          proj.dx = proj.dx - dot2 * nx;
          proj.dy = proj.dy - dot2 * ny;
          // Push projectile out of collision
          proj.x = target.x + nx * (RADIUS + PROJECTILE_RADIUS + 1);
          proj.y = target.y + ny * (RADIUS + PROJECTILE_RADIUS + 1);
          proj.lastRicochetId = target.id;
          frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'ricochet' });
          ricocheted = true;
          break;
        }

        // Normal hit — apply damage
        frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'tank' });

        const armourUpgrade = (room.playerPickups[target.id] && room.playerPickups[target.id].armour) ? 5 : 0;
        let armour;
        if (relAngle >= Math.PI * 0.75) {
          armour = ARMOUR_FRONT + armourUpgrade;
        } else if (isRear) {
          armour = ARMOUR_REAR + armourUpgrade;
        } else {
          armour = ARMOUR_SIDE + armourUpgrade;
        }

        target.hp -= (BULLET_DAMAGE - armour);
        room.projectiles[id] = null;

        if (target.hp <= 0) {
          target.hp = 0;
          target.alive = false;
          room.projectiles[target.id] = null;
          sendToPlayer(room, target.id, { type: 'feedback', action: 'vibrate', duration: 500 });
        } else {
          sendToPlayer(room, target.id, { type: 'feedback', action: 'vibrate', duration: 300 });
        }

        sendToPlayer(room, id, { type: 'feedback', action: 'hit_confirm' });

        hitPlayer = true;
        break;
      }
    }
    if (ricocheted) continue;
    if (proj.lastRicochetId) proj.lastRicochetId = null;
    if (hitPlayer) continue;
  }

  const alivePlayers = room.players.filter(pl => pl.alive);
  if (alivePlayers.length <= 1 && room.players.length > 1) {
    const nowMs = Date.now();
    const frame = {
      type: 'frame',
      players: room.players.map(pl => {
        const repairB = (room.playerPickups[pl.id] && room.playerPickups[pl.id].heal) ? 3000 : 0;
        return {
          id: pl.id, name: pl.name, x: Math.round(pl.x), y: Math.round(pl.y),
          fdx: room.facing[pl.id].dx, fdy: room.facing[pl.id].dy,
          score: pl.score, hp: pl.hp, alive: pl.alive,
          healReady: !room.healState[pl.id].active && (nowMs - room.healState[pl.id].endTime) >= (HEAL_COOLDOWN - repairB),
          healing: room.healState[pl.id].active
        };
      }),
      projectiles: [],
      hits: frameHits,
      destructHits: frameDestructHits,
      shots: room.frameShotsFired,
      pickups: room.pickups,
      playerPickups: room.playerPickups
    };
    sendToGame(room, frame);
    room.frameShotsFired = [];

    room.gameRunning = false;
    if (room.gameLoopInterval) { clearInterval(room.gameLoopInterval); room.gameLoopInterval = null; }

    const winner = alivePlayers[0] || null;
    if (winner) {
      winner.score++;
    }

    const scores = {};
    const names = {};
    room.players.forEach(pl => { scores[pl.id] = pl.score; names[pl.id] = pl.name; });
    sendToGame(room, { type: 'game_over', winnerId: winner ? winner.id : null, scores, names });

    for (const pl of room.players) {
      sendToPlayer(room, pl.id, { type: 'score_update', scores });
      sendToPlayer(room, pl.id, { type: 'round_over' });
    }

    for (const pl of room.players) {
      room.readyState[pl.id] = pl.isBot ? true : false;
    }
    sendToGame(room, { type: 'ready_update', readyState: room.readyState });

    return;
  }

  const nowMs = Date.now();
  const frame = {
    type: 'frame',
    players: room.players.map(p => {
      const repairB = (room.playerPickups[p.id] && room.playerPickups[p.id].heal) ? 3000 : 0;
      return {
        id: p.id,
        name: p.name,
        x: Math.round(p.x),
        y: Math.round(p.y),
        fdx: room.facing[p.id].dx,
        fdy: room.facing[p.id].dy,
        score: p.score,
        hp: p.hp,
        alive: p.alive,
        healReady: !room.healState[p.id].active && (nowMs - room.healState[p.id].endTime) >= (HEAL_COOLDOWN - repairB),
        healing: room.healState[p.id].active
      };
    }),
    projectiles: [],
    hits: frameHits,
    destructHits: frameDestructHits,
    shots: room.frameShotsFired,
    pickups: room.pickups,
    playerPickups: room.playerPickups
  };

  for (const p of room.players) {
    if (room.projectiles[p.id]) {
      frame.projectiles.push({
        x: Math.round(room.projectiles[p.id].x),
        y: Math.round(room.projectiles[p.id].y),
        owner: p.id
      });
    }
  }

  sendToGame(room, frame);
  room.frameShotsFired = [];
}

function sendToGame(room, obj) {
  const data = JSON.stringify(obj);
  for (const gs of room.gameScreens) {
    if (gs.readyState === 1) gs.send(data);
  }
}

function sendInitToOneGame(room, ws) {
  sendToOneGame(ws, {
    type: 'init',
    roomId: room.id,
    players: room.players.map(p => ({
      id: p.id, code: p.code, connected: p.connected, score: p.score, isBot: p.isBot || false, name: p.name
    })),
    walls: room.walls, destructibles: room.destructibles, bgSeed: room.bgSeed,
    colors: PLAYER_COLORS
  });
}

function sendToOneGame(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function sendToPlayer(room, id, obj) {
  const p = room.players[id - 1];
  if (p && p.ws && p.ws.readyState === 1) {
    p.ws.send(JSON.stringify(obj));
  }
}

// ── Start ──
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  KOSH TANKS SERVER (Multi-Room)');
  console.log('========================================');
  console.log(`  Listening on port ${PORT}`);
  console.log('  Rooms are created on demand');
  console.log('========================================');
  console.log('');
});
