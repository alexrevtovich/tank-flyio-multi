'use strict';

const { sendToOneGame, sendInitToGame, sendInitToOneGame } = require('./net');
const { generateWalls, generateDestructibles } = require('./map');
const { initPlayers } = require('./players');
const { rooms, generateRoomId, createRoom } = require('./rooms');

/**
 * Handle 'register_game' — join an existing room or create a new one.
 *
 * Returns { assignedRole, assignedRoom } on success, or null if an error was
 * sent and the caller should break without updating state.
 */
function handleRegisterGame(ws, msg, _state) {
  let roomId = msg.roomId || null;
  let room;
  let isNewRoom = false;

  if (roomId && rooms.has(roomId)) {
    room = rooms.get(roomId);
  } else if (roomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    return null;
  } else {
    roomId = generateRoomId();
    room = createRoom(roomId);
    isNewRoom = true;
  }

  room.gameScreens.push(ws);
  if (isNewRoom) room.ownerWs = ws;

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

  return { assignedRole: 'game', assignedRoom: room };
}

/**
 * Handle 'set_player_count' — owner-only, lobby-only.
 */
function handleSetPlayerCount(ws, msg, state) {
  const { assignedRole, assignedRoom } = state;
  if (!assignedRoom || assignedRole !== 'game') return;
  if (ws !== assignedRoom.ownerWs) return;
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
}

/**
 * Handle 'add_bot' — owner-only, lobby-only.
 * Saves connected human state before reinit and restores it after.
 */
function handleAddBot(ws, state) {
  const { assignedRole, assignedRoom } = state;
  if (!assignedRoom || assignedRole !== 'game') return;
  if (ws !== assignedRoom.ownerWs) return;
  const room = assignedRoom;
  if (room.gameRunning) return;
  if (room.playerCount >= 7) return;

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
}

/**
 * Handle 'remove_bot' — owner-only, lobby-only.
 * Removes the highest-numbered bot slot while preserving all human connections.
 */
function handleRemoveBot(ws, state) {
  const { assignedRole, assignedRoom } = state;
  if (!assignedRoom || assignedRole !== 'game') return;
  if (ws !== assignedRoom.ownerWs) return;
  const room = assignedRoom;
  if (room.gameRunning) return;
  if (room.botPlayerIds.size === 0) return;

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
}

module.exports = { handleRegisterGame, handleSetPlayerCount, handleAddBot, handleRemoveBot };
