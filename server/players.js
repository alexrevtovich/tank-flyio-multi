'use strict';

const { CANVAS_W, CANVAS_H, MAX_HP } = require('./config');
const { generateWalls, generateDestructibles } = require('./map');

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
  room.healState = {};
  room.botState = {};
  room.readyState = {};

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

module.exports = { getSpawnPositions, initPlayers, resetRound };
