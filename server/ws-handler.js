'use strict';

const { MAX_WS_MESSAGE_BYTES, PLAYER_COLORS, HEAL_COOLDOWN } = require('./config');
const { sendToGame, sendToPlayer } = require('./net');
const { tryShoot } = require('./projectiles');
const { rooms, checkRoomCleanup } = require('./rooms');
const { startGame, restartRound } = require('./game-loop');
const { parseIncomingMessage } = require('./ws-protocol');
const { handleRegisterGame, handleSetPlayerCount, handleAddBot, handleRemoveBot } = require('./room-lobby');

function handleWSConnection(ws) {
  let assignedRole = null;
  let assignedRoom = null;

  ws.on('message', (raw, isBinary) => {
    const result = parseIncomingMessage(raw, isBinary, MAX_WS_MESSAGE_BYTES);
    if (!result.ok) {
      if (result.close) ws.close(result.close.code, result.close.reason);
      return;
    }
    const { msg } = result;

    switch (msg.type) {
      case 'register_game': {
        const newState = handleRegisterGame(ws, msg, { assignedRole, assignedRoom });
        if (newState) { assignedRole = newState.assignedRole; assignedRoom = newState.assignedRoom; }
        break;
      }

      case 'set_player_count':
        handleSetPlayerCount(ws, msg, { assignedRole, assignedRoom });
        break;

      case 'add_bot':
        handleAddBot(ws, { assignedRole, assignedRoom });
        break;

      case 'remove_bot':
        handleRemoveBot(ws, { assignedRole, assignedRoom });
        break;

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

module.exports = { handleWSConnection };
