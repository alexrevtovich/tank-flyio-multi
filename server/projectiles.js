'use strict';

const {
  RADIUS, PROJECTILE_RADIUS, PROJECTILE_SPEED, FIRE_COOLDOWN,
  CANVAS_W, CANVAS_H, DESTRUCT_RADIUS,
  ARMOUR_FRONT, ARMOUR_SIDE, ARMOUR_REAR, BULLET_DAMAGE
} = require('./config');
const { toWallLocal, isDestructibleSolid } = require('./map');
const { sendToPlayer } = require('./net');

function tryShoot(room, playerId) {
  if (room.projectiles[playerId] !== null) return;

  const p = room.players[playerId - 1];
  if (!p || !p.alive) return;

  const now = Date.now();
  const cooldown = p.isBot ? FIRE_COOLDOWN * 2 : FIRE_COOLDOWN;
  if (now - room.lastFireTime[playerId] < cooldown) return;
  const dir = room.facing[playerId];

  if (dir.dx === 0 && dir.dy === 0) return;

  room.lastFireTime[playerId] = now;

  room.projectiles[playerId] = {
    x: p.x + dir.dx * (RADIUS + PROJECTILE_RADIUS + 2),
    y: p.y + dir.dy * (RADIUS + PROJECTILE_RADIUS + 2),
    dx: dir.dx * PROJECTILE_SPEED,
    dy: dir.dy * PROJECTILE_SPEED,
    ownerId: playerId,
    lastRicochetId: null,
    createdAt: now
  };

  room.frameShotsFired.push(playerId);

  sendToPlayer(room, playerId, { type: 'shot_fired' });
}

function updateProjectiles(room) {
  const frameHits = room.frameHits;
  const frameDestructHits = room.frameDestructHits;
  const now = Date.now();

  for (const p of room.players) {
    const id = p.id;
    const proj = room.projectiles[id];
    if (!proj) continue;

    proj.x += proj.dx;
    proj.y += proj.dy;

    if (now - proj.createdAt >= 2000) {
      frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'wall' });
      room.projectiles[id] = null;
      continue;
    }

    if (proj.x < 0 || proj.x > CANVAS_W || proj.y < 0 || proj.y > CANVAS_H) {
      frameHits.push({
        x: Math.round(Math.max(0, Math.min(CANVAS_W, proj.x))),
        y: Math.round(Math.max(0, Math.min(CANVAS_H, proj.y))),
        hitType: 'wall'
      });
      room.projectiles[id] = null;
      continue;
    }

    let hitWall = false;
    for (const wall of room.walls) {
      const hw = wall.w / 2, hh = wall.h / 2;
      const local = toWallLocal(proj.x, proj.y, wall);
      if (local.x >= -hw && local.x <= hw && local.y >= -hh && local.y <= hh) {
        frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'wall' });
        room.projectiles[id] = null;
        hitWall = true;
        break;
      }
    }
    if (hitWall) continue;

    let hitDestruct = false;
    for (const obj of room.destructibles) {
      if (isDestructibleSolid(obj, proj.x, proj.y)) {
        const cx = Math.round(proj.x), cy = Math.round(proj.y);
        obj.holes.push({ cx, cy, r: DESTRUCT_RADIUS });
        frameHits.push({ x: cx, y: cy, hitType: 'wall' });
        frameDestructHits.push({ x: cx, y: cy, r: DESTRUCT_RADIUS });
        room.projectiles[id] = null;
        hitDestruct = true;
        break;
      }
    }
    if (hitDestruct) continue;

    let hitPlayer = false;
    let ricocheted = false;
    for (const target of room.players) {
      if (target.id === id || !target.alive) continue;
      if (target.id === proj.lastRicochetId) continue;
      const dx = proj.x - target.x;
      const dy = proj.y - target.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < RADIUS + PROJECTILE_RADIUS) {
        // Check angle of incidence for ricochet
        const tFace = room.facing[target.id];
        const projAngle = Math.atan2(proj.dy, proj.dx);
        const faceAngle = Math.atan2(tFace.dy, tFace.dx);
        let relAngle = Math.abs(projAngle - faceAngle);
        if (relAngle > Math.PI) relAngle = 2 * Math.PI - relAngle;

        // Surface normal at impact (from tank center to projectile)
        const nLen = dist > 0 ? dist : 1;
        const nx = dx / nLen, ny = dy / nLen;
        // Incoming direction (reversed projectile velocity)
        const projSpeed = Math.sqrt(proj.dx * proj.dx + proj.dy * proj.dy);
        if (projSpeed < 0.01) { /* dead projectile */ room.projectiles[id] = null; hitPlayer = true; break; }
        const inX = -proj.dx / projSpeed, inY = -proj.dy / projSpeed;
        // Angle of incidence: angle between incoming dir and surface normal
        const cosAngle = nx * inX + ny * inY;

        // Ricochet: angle > 50° from normal (< 40° from surface), but NOT rear hits
        const isRear = relAngle <= Math.PI * 0.25;
        if (!isRear && cosAngle < 0.6428) { // cos(50°) ≈ 0.6428
          // Ricochet — reflect projectile off surface normal
          const dot2 = 2 * (proj.dx * nx + proj.dy * ny);
          proj.dx = proj.dx - dot2 * nx;
          proj.dy = proj.dy - dot2 * ny;
          // Push projectile out of collision
          proj.x = target.x + nx * (RADIUS + PROJECTILE_RADIUS + 1);
          proj.y = target.y + ny * (RADIUS + PROJECTILE_RADIUS + 1);
          proj.lastRicochetId = target.id;
          frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'ricochet' });
          ricocheted = true;
          break;
        }

        // Normal hit — apply damage
        frameHits.push({ x: Math.round(proj.x), y: Math.round(proj.y), hitType: 'tank' });

        const armourUpgrade = (room.playerPickups[target.id] && room.playerPickups[target.id].armour) ? 5 : 0;
        let armour;
        if (relAngle >= Math.PI * 0.75) {
          armour = ARMOUR_FRONT + armourUpgrade;
        } else if (isRear) {
          armour = ARMOUR_REAR + armourUpgrade;
        } else {
          armour = ARMOUR_SIDE + armourUpgrade;
        }

        target.hp -= (BULLET_DAMAGE - armour);
        room.projectiles[id] = null;

        if (target.hp <= 0) {
          target.hp = 0;
          target.alive = false;
          room.projectiles[target.id] = null;
          sendToPlayer(room, target.id, { type: 'feedback', action: 'vibrate', duration: 500 });
        } else {
          sendToPlayer(room, target.id, { type: 'feedback', action: 'vibrate', duration: 300 });
        }

        sendToPlayer(room, id, { type: 'feedback', action: 'hit_confirm' });

        hitPlayer = true;
        break;
      }
    }
    if (ricocheted) continue;
    if (proj.lastRicochetId) proj.lastRicochetId = null;
    if (hitPlayer) continue;
  }
}

module.exports = { tryShoot, updateProjectiles };
