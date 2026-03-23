'use strict';

const { ALPHABET } = require('./config');
const { initPlayers } = require('./players');
const { generateWalls, generateDestructibles } = require('./map');

const rooms = new Map();

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

module.exports = { rooms, generateRoomId, createRoom, checkRoomCleanup };
