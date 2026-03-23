'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { PORT } = require('./server/config');
const { rooms } = require('./server/rooms');
const { handleWSConnection } = require('./server/ws-handler');

// ── MIME types ──
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json',
  '.mp3':  'audio/mpeg'
};

const publicDir = path.resolve(__dirname, 'public');

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let urlPath = req.url.split('?')[0];

  if (urlPath === '/api/rooms') {
    const data = [];
    for (const [id, room] of rooms) {
      const players = room.players.map(p => ({
        id: p.id, name: p.name, connected: p.connected, isBot: p.isBot || false
      }));
      data.push({
        id,
        gameRunning: room.gameRunning,
        playerCount: room.playerCount,
        screens: room.gameScreens.length,
        players
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const safePath = path.resolve(publicDir, '.' + urlPath);
  if (!safePath.startsWith(publicDir + path.sep) && safePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(safePath);
  const stream = fs.createReadStream(safePath);

  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') { res.end(); stream.destroy(); return; }
    stream.pipe(res);
  });

  stream.on('error', () => {
    res.writeHead(404);
    res.end('Not Found');
  });
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  handleWSConnection(ws);
});

// ── Start ──
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  KOSH TANKS SERVER (Multi-Room)');
  console.log('========================================');
  console.log(`  Listening on port ${PORT}`);
  console.log('  Rooms are created on demand');
  console.log('========================================');
  console.log('');
});
