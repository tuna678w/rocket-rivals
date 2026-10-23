# Rocket Rivals
1v1 car soccer in the browser. Zero dependencies (Node >= 18).

Local: `npm start` → http://localhost:3000   ·   edit-friendly: `DEV_RELOAD=1 npm start` (serves `public/` from disk on every request)
Tests: `npm test` (physics, fuzz, real-WebSocket network suite)

## Layout
- `server.js` HTTP + WebSocket server, rooms, bot, quick match
- `match.js` authoritative 60 Hz physics, boost pads, bot AI
- `public/shared.js` arena size, boost pad layout, tuning values (used by server AND client)
- `public/gl.js world.js cars.js fx.js audio.js game.js` WebGL renderer, stadium, cars, particles, sound, client

## Tuning
Everything gameplay-related lives in `public/shared.js` (`TUNING`, `PAD_TYPES`, pad layout, kickoff positions).

## Render
Push this folder to GitHub → Render → New → Blueprint (uses `render.yaml`). Health check `/health`.
Free plan sleeps when idle (first load ~30 s); rooms are in memory.

Controls: WASD drive · Shift boost · Space jump (tap again + direction = flip) · Ctrl drift · W/S pitch in air · Q/E air roll · C ball cam · M mute. Settings (⚙): graphics LOW/MED/HIGH, volume, camera shake.
