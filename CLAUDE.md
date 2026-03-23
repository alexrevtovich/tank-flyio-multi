# Kosh Tanks Server — Claude Context

---

## Project Overview

This is a real-time multiplayer tank game server written in Node.js.

Architecture:
- HTTP server serves static frontend from `/public`
- WebSocket server handles all game logic
- Multiple rooms exist simultaneously
- Each room contains:
  - 1+ game screens (render clients)
  - 2–7 players (humans or bots)

The server is authoritative:
- All movement, shooting, collision, and game state are computed on the server
- Clients only send input (joystick, shoot, heal, etc.)

There is NO persistence. All rooms and state exist only in memory.

---

## Core Architecture

### Rooms
Rooms are stored in:
```js
const rooms = new Map();
```

Rooms are created on demand via `register_game`.

Each room contains:

- players[] (array indexed by id - 1)
- inputState
- facing
- projectiles
- lastFireTime
- healState
- botPlayerIds
- botState
- readyState
- pickups
- playerPickups
- walls
- destructibles
- gameScreens (WebSocket connections)
- ownerWs (room owner)

---

### Player Model

Players are stored in an array:

```js
room.players[id - 1]
```

This is a CRITICAL design choice.

- `player.id` MUST always equal index + 1
- Many systems depend on this (inputState, facing, projectiles, etc.)

Players:
- Humans → connect via `join`
- Bots → simulated server-side

Bots are tracked via:
```js
room.botPlayerIds
```

---

### Game Loop

- Runs using `setInterval(..., 1000 / 45)`
- Handles:
  - movement
  - collision
  - shooting
  - healing
  - pickups
  - win condition

⚠️ Timing is NOT precise. It may drift under load.

---

## Non-Negotiable Invariants

Claude MUST NOT violate these:

1. **Player identity = array index**
   - `player.id === index + 1`
   - Never reorder players without full system rewrite

2. **Human players must NEVER be lost**
   - Especially during `add_bot` / `remove_bot`
   - Preserve connections, names, scores

3. **Server is authoritative**
   - Clients cannot modify game state directly

4. **All WebSocket input must be validated**
   - Enforce type checks
   - Clamp numeric values
   - Enforce message size limits

5. **No blocking operations**
   - No sync file IO
   - No heavy CPU spikes inside game loop

6. **All per-player state must stay in sync**
   If new per-player data is added:
   - Must be initialized in `initPlayers()`
   - Must be reset in `resetRound()`

7. **Room lifecycle must not break reconnect**
   - Do not delete active rooms prematurely

---

## Known Weak Points / Current Bugs

These are known issues in current implementation:

- Player-slot coupling is fragile (id ↔ index)
- Room cleanup has no inactivity TTL (stale rooms possible)
- Game loop uses `setInterval` (timing drift)
- Parallel state maps increase risk of desync
- Pickup spawning does NOT check destructible obstacles
- Collision resolution skips exact-overlap edge cases
- Room ID fallback is not guaranteed unique
- Potential excessive object allocation each frame

Claude SHOULD prioritize these when improving code.

---

## Message Protocol Summary

### Incoming (client → server)

- register_game
- set_player_count
- add_bot
- remove_bot
- join
- joystick
- shoot
- heal
- restart_game
- ready
- unready

### Outgoing (server → client)

- init
- room_joined
- game_start
- frame
- game_over
- ready_update
- feedback
- score_update
- player_joined
- player_left

⚠️ Any protocol change must be explicitly documented here.

---

## Commands Claude Should Run

After modifying code:

```bash
npm run lint
node server.js
```

If lint fails → fix before continuing.

---

## Rules for Editing

Claude must follow:

- Prefer minimal, safe changes over large rewrites
- Do NOT introduce frameworks (Express, etc.) unless asked
- Do NOT silently change WebSocket protocol
- Do NOT break reconnect logic
- Always explain reasoning for non-trivial changes
- Avoid "clean code" refactors that risk behavior changes

---

## Refactor Boundaries

Claude MAY refactor:
- small functions
- duplicated logic
- validation layers
- constants / config organization

Claude MUST NOT refactor without explicit request:
- player storage model
- room architecture
- message protocol
- game loop structure

If proposing major refactor:
- explain benefits
- explain risks
- do NOT partially implement

---

## Testing Checklist

After any change, verify:

### Core flows
- Player join works
- Player reconnect works correctly
- Game screen connects and receives init

### Bots
- Add bot works
- Remove bot does NOT remove humans
- Bot behavior still functions

### Gameplay
- Game starts correctly
- Movement works
- Shooting works
- Damage is applied correctly
- Healing works

### Round lifecycle
- Game over triggers correctly
- Scores update correctly
- Ready system works
- Restart round works

### Networking
- No crashes on invalid messages
- Large messages are rejected
- Disconnected sockets handled safely

---

## Future Direction (Guidance)

Preferred improvements:

- Replace parallel maps with per-player state objects
- Add room inactivity TTL cleanup
- Replace setInterval with fixed timestep loop
- Add per-socket rate limiting
- Optimize collision checks if scaling up

---

## What Claude Must Never Do

- Rewrite entire server without request
- Break player identity mapping
- Introduce silent behavioral changes
- Assume correctness of client input
- Ignore known weak points
