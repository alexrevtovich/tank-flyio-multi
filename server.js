const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const {
  PORT, MAX_WS_MESSAGE_BYTES, ALPHABET, PLAYER_COLORS,
  RADIUS, SPEED, CANVAS_W, CANVAS_H,
  MAX_HP,
  HEAL_PER_SEC, HEAL_DURATION, HEAL_COOLDOWN,
  PICKUP_RADIUS, PICKUP_INTERVAL, PICKUP_TYPES
} = require('./server/config');

const { sendToGame, sendToOneGame, sendInitToGame, sendInitToOneGame, sendToPlayer } = require('./server/net');
const { generateWalls, toWallLocal, generateDestructibles } = require('./server/map');
const { initPlayers, resetRound } = require('./server/players');
const { tryShoot, updateProjectiles } = require('./server/projectiles');
const { updateBotAI } = require('./server/bots');

// ── Room ID generation ──
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
    frameHits: [],
    frameDestructHits: [],
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

const publicDir = path.resolve(__dirname, 'public');

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

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

  const safePath = path.resolve(publicDir, '.' + urlPath);
  if (!safePath.startsWith(publicDir + path.sep) && safePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(safePath);
  const stream = fs.createReadStream(safePath);

  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') { res.end(); stream.destroy(); return; }
    stream.pipe(res);
  });

  stream.on('error', () => {
    res.writeHead(404);
    res.end('Not Found');
  });
});

// ── WebSocket Handler ──
function handleWSConnection(ws) {
  let assignedRole = null;
  let assignedRoom = null;

  ws.on('message', (raw, isBinary) => {
    if (isBinary) { ws.close(1003, 'Binary not supported'); return; }
    const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
    if (size > MAX_WS_MESSAGE_BYTES) { ws.close(1009, 'Message too large'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

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
        // Snapshot slot info before rebuild, splicing out the removed bot slot
        const removedId = [...room.botPlayerIds].sort((a, b) => b - a)[0];
        const oldSlots = room.players.map(p => ({
          isBot: !!p.isBot, connected: !!p.connected, ws: p.ws, score: p.score, name: p.name
        }));
        oldSlots.splice(removedId - 1, 1);
        // Rebuild botPlayerIds from remaining slots
        room.botPlayerIds = new Set();
        oldSlots.forEach((slot, i) => { if (slot.isBot) room.botPlayerIds.add(i + 1); });
        const newCount = Math.max(2, oldSlots.length);
        initPlayers(room, newCount);
        // Restore human connections into new slots
        oldSlots.forEach((slot, i) => {
          const p = room.players[i];
          if (!p || slot.isBot) return;
          p.ws = slot.connected ? slot.ws : null;
          p.connected = slot.connected;
          p.score = slot.score;
          p.name = slot.name;
        });
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
          try { player.ws.close(); } catch (_e) { /* old WS already closing */ }
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
          const hasScores = room.players.some(p => p.score > 0);
          if (hasScores) {
            restartRound(room);
          } else {
            startGame(room);
          }
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
      // Guard: only clean up if this WS is still the active connection.
      // A reconnect closes the old WS explicitly; its async 'close' fires later
      // and must not overwrite the new WS already set in the 'join' handler.
      if (player && player.ws === ws) {
        player.connected = false;
        player.ws = null;
        room.inputState[assignedRole] = { x: 0, y: 0 };
        sendToGame(room, { type: 'player_left', playerId: assignedRole });
        console.log(`Room ${room.id}: Player ${assignedRole} disconnected`);
        // Game continues — player stays frozen until they reconnect or are eliminated
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

// ── Game Loop ──
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
  room.frameShotsFired.length = 0;
  room.frameHits.length = 0;
  room.frameDestructHits.length = 0;

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
        p.x += plx * wall.cos + ply * wall.sin;
        p.y += -plx * wall.sin + ply * wall.cos;
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

  updateProjectiles(room);

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
      hits: room.frameHits,
      destructHits: room.frameDestructHits,
      shots: room.frameShotsFired,
      pickups: room.pickups,
      playerPickups: room.playerPickups
    };
    sendToGame(room, frame);

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
    hits: room.frameHits,
    destructHits: room.frameDestructHits,
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
