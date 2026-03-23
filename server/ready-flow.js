'use strict';

const { sendToGame } = require('./net');
const { restartRound } = require('./game-loop');

/**
 * Handle 'ready' — player signals they are ready for the next round.
 */
function handleReady(state) {
  const { assignedRole, assignedRoom } = state;
  if (typeof assignedRole !== 'number' || !assignedRoom || assignedRoom.gameRunning) return;
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

/**
 * Handle 'unready' — player withdraws their ready signal.
 */
function handleUnready(state) {
  const { assignedRole, assignedRoom } = state;
  if (typeof assignedRole !== 'number' || !assignedRoom || assignedRoom.gameRunning) return;
  const room = assignedRoom;
  room.readyState[assignedRole] = false;
  console.log(`Room ${room.id}: Player ${assignedRole} is not ready`);
  sendToGame(room, { type: 'ready_update', readyState: room.readyState });
}

module.exports = { handleReady, handleUnready };
