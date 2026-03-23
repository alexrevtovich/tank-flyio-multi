'use strict';

const { PLAYER_COLORS } = require('./config');

function sendToGame(room, obj) {
  const data = JSON.stringify(obj);
  for (const gs of room.gameScreens) {
    if (gs.readyState === 1) gs.send(data);
  }
}

function sendToOneGame(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

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

function sendToPlayer(room, id, obj) {
  const p = room.players[id - 1];
  if (p && p.ws && p.ws.readyState === 1) {
    p.ws.send(JSON.stringify(obj));
  }
}

module.exports = { sendToGame, sendToOneGame, sendInitToGame, sendInitToOneGame, sendToPlayer };
