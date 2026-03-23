'use strict';

const { tryShoot } = require('./projectiles');

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

module.exports = { updateBotAI };
