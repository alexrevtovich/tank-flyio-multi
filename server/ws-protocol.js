'use strict';

// All message types the server accepts from clients.
// Unknown types are silently ignored by the switch in ws-handler.
const ALLOWED_MESSAGE_TYPES = [
  'register_game',
  'set_player_count',
  'add_bot',
  'remove_bot',
  'join',
  'joystick',
  'shoot',
  'heal',
  'restart_game',
  'ready',
  'unready'
];

/**
 * Parse and validate an incoming WebSocket message.
 *
 * Returns one of:
 *   { ok: true, msg }                          — valid, parsed message
 *   { ok: false, close: { code, reason } }     — must close the socket
 *   { ok: false }                              — silently discard
 */
function parseIncomingMessage(raw, isBinary, maxBytes) {
  if (isBinary) {
    return { ok: false, close: { code: 1003, reason: 'Binary not supported' } };
  }

  const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
  if (size > maxBytes) {
    return { ok: false, close: { code: 1009, reason: 'Message too large' } };
  }

  let msg;
  try { msg = JSON.parse(raw); } catch { return { ok: false }; }
  if (!msg || typeof msg.type !== 'string') return { ok: false };

  return { ok: true, msg };
}

module.exports = { parseIncomingMessage, ALLOWED_MESSAGE_TYPES };
