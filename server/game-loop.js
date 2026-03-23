'use strict';

const {
  RADIUS, SPEED, CANVAS_W, CANVAS_H,
  MAX_HP, HEAL_PER_SEC, HEAL_DURATION, HEAL_COOLDOWN,
  PICKUP_RADIUS, PICKUP_INTERVAL, PICKUP_TYPES
} = require('./config');
const { sendToGame, sendToPlayer } = require('./net');
const { toWallLocal } = require('./map');
const { resetRound } = require('./players');
const { updateBotAI } = require('./bots');
const { updateProjectiles } = require('./projectiles');

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

module.exports = { startGame, restartRound };
