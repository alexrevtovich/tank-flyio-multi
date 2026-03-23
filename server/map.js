'use strict';

const { CANVAS_W, CANVAS_H, DESTRUCT_COUNT } = require('./config');

function generateWalls() {
  const walls = [];
  for (let i = 0; i < 10; i++) {
    const w = 10 + Math.floor(Math.random() * 11);
    const h = 20 + Math.floor(Math.random() * 61);
    const x = 100 + Math.floor(Math.random() * (CANVAS_W - 200));
    const y = 100 + Math.floor(Math.random() * (CANVAS_H - 200));
    const angle = Math.random() < 0.5 ? 0 : Math.PI / 2;
    walls.push({ x, y, w, h, angle, cos: Math.cos(-angle), sin: Math.sin(-angle) });
  }
  return walls;
}

function toWallLocal(wx, wy, wall) {
  const dx = wx - wall.x;
  const dy = wy - wall.y;
  return { x: dx * wall.cos - dy * wall.sin, y: dx * wall.sin + dy * wall.cos };
}

function generateDestructibles() {
  const objs = [];
  for (let i = 0; i < DESTRUCT_COUNT; i++) {
    const w = 40 + Math.floor(Math.random() * 41);
    const h = 40 + Math.floor(Math.random() * 41);
    const x = 120 + Math.floor(Math.random() * (CANVAS_W - 240));
    const y = 120 + Math.floor(Math.random() * (CANVAS_H - 240));
    objs.push({ id: i, x, y, w, h, holes: [] });
  }
  return objs;
}

function isDestructibleSolid(obj, px, py) {
  const hw = obj.w / 2, hh = obj.h / 2;
  if (px < obj.x - hw || px > obj.x + hw ||
      py < obj.y - hh || py > obj.y + hh) return false;
  for (const hole of obj.holes) {
    const dx = px - hole.cx, dy = py - hole.cy;
    if (dx * dx + dy * dy <= hole.r * hole.r) return false;
  }
  return true;
}

module.exports = { generateWalls, toWallLocal, generateDestructibles, isDestructibleSolid };
