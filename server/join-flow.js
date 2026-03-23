'use strict';

const { PLAYER_COLORS } = require('./config');
const { sendToGame } = require('./net');
const { rooms } = require('./rooms');
const { startGame, restartRound } = require('./game-loop');

/**
 * Handle 'join' — player connects to a room using a code.
 *
 * Returns { assignedRole, assignedRoom } on success, or null if an error was
 * sent and the caller should break without updating state.
 */
function handleJoin(ws, msg, _state) {
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
    return null;
  }

  const player = room.players.find(p => p.code === code);
  if (!player) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid code' }));
    return null;
  }

  if (player.ws && player.ws !== ws) {
    try { player.ws.close(); } catch (_e) { /* old WS already closing */ }
  }
  player.ws = ws;
  player.connected = true;

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

  return { assignedRole: player.id, assignedRoom: room };
}

module.exports = { handleJoin };
