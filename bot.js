// bot.js — Fixed movement packets & realistic joining
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const http = require('http');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
let servers = [];
try {
  servers = JSON.parse(process.env.SERVERS || '[]');
} catch (e) {
  console.error('[Config] Failed to parse SERVERS:', e.message);
}
if (servers.length === 0) {
  console.error('[Config] No servers configured.');
  process.exit(1);
}

// AI config (optional)
const AI = {
  enabled: !!process.env.AI_API_KEY,
  apiKey: process.env.AI_API_KEY,
  baseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
  model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
};

// ─────────────────────────────────────────────
// HEALTH SERVER
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', ai: AI.enabled, bots: Object.keys(bots) }));
}).listen(port, () => console.log(`[Health] Listening on ${port}`));

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const bots = {};

// ─────────────────────────────────────────────
// BOT MANAGER
// ─────────────────────────────────────────────
function startBot(server) {
  const label = server.label || `${server.host}:${server.port}`;
  console.log(`[${label}] Connecting as ${server.username}...`);

  const bot = mineflayer.createBot({
    host: server.host,
    port: server.port,
    username: server.username,
    version: server.version,
    auth: server.auth || 'offline',
    // ✅ FIX #1: Enable physics so the server receives valid movement packets.
    physicsEnabled: true,
    // ✅ FIX #2: Use a vanilla client brand so anti-cheat is less suspicious.
    client: { brand: 'vanilla' },
    // ✅ FIX #3: Hide minor errors to prevent console spam.
    hideErrors: true,
    // ✅ FIX #4: Match a typical player's view distance.
    viewDistance: 'normal',
  });

  bot.loadPlugin(pathfinder);
  bots[label] = { bot, server, reconnectTimer: null };

  // ── MOVEMENT CONFIG (The Critical Part) ──
  bot.once('spawn', () => {
    console.log(`[${label}] ${bot.username} joined.`);

    const mcData = require('minecraft-data')(bot.version);
    const move = new Movements(bot, mcData);

    // These settings make the bot move like a real player.
    // They prevent the "flying" or "speed" flags that cause kicks.
    move.canDig = false;               // Don't break blocks while pathing.
    move.allow1by1towers = false;      // No pillar-jumping.
    move.allowParkour = true;          // Allow jumping over gaps (human-like).
    move.allowSprinting = true;        // Allow sprinting when appropriate.
    move.canOpenDoors = true;
    move.canOpenGates = true;
    move.allowFreeMotion = false;      // 🚨 MUST BE FALSE. Never allow flying.
    move.scafoldingBlocks = [];        // Don't place blocks to path.

    bot.pathfinder.setMovements(move);

    // Delay the first action to let movement rules apply fully.
    // (Pathfinder can ignore rules for the first ~2 seconds after spawn.)[reference:2]
    setTimeout(() => {
      startAntiAFK(bot, label);
      startIdleWander(bot, label);
    }, 3000);
  });

  // ── BASIC CHAT (Optional AI) ──
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    console.log(`[${label}] ${username}: ${message}`);
    if (AI.enabled && message.toLowerCase().includes(bot.username.toLowerCase())) {
      // (Your existing AI chat logic would go here)
    }
  });

  bot.on('end', (reason) => {
    console.log(`[${label}] Disconnected: ${reason}. Reconnecting in 10s...`);
    scheduleReconnect(label, 10000);
  });
  bot.on('kicked', (reason) => {
    console.log(`[${label}] Kicked: ${JSON.stringify(reason)}. Reconnecting in 30s...`);
    scheduleReconnect(label, 30000);
  });
  bot.on('error', (err) => console.error(`[${label}] Error: ${err.message}`));
}

// ─────────────────────────────────────────────
// LIGHTWEIGHT ANTI-AFK (RAM-friendly)
// ─────────────────────────────────────────────
function startAntiAFK(bot, label) {
  // Occasional jump (like a bored player)
  setInterval(() => {
    if (!bot.entity) return;
    if (Math.random() < 0.4) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 300);
    }
  }, 45000);

  // Smooth look around (prevents static-bot detection)
  setInterval(() => {
    if (!bot.entity) return;
    // FIX #5: Use 'false' for smooth rotation. Instant turns flag anti-cheat.
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, false);
  }, 30000);
}

// ─────────────────────────────────────────────
// IDLE WANDER (Real walking, no teleporting)
// ─────────────────────────────────────────────
function startIdleWander(bot, label) {
  const wander = async () => {
    if (!bot.entity) return setTimeout(wander, 30000);
    // Don't wander if a player is nearby (looks suspicious)
    const nearbyPlayer = bot.nearestEntity(e =>
      e.type === 'player' && e.position.distanceTo(bot.entity.position) < 15
    );
    if (nearbyPlayer) return setTimeout(wander, 30000);

    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const dist = 3 + Math.random() * 5;
    const x = Math.floor(pos.x + Math.cos(angle) * dist);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z + Math.sin(angle) * dist);

    try {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
    } catch { /* ignore unreachable */ }
    setTimeout(wander, 20000 + Math.random() * 20000);
  };
  setTimeout(wander, 5000);
}

function scheduleReconnect(label, delay) {
  const entry = bots[label];
  if (!entry) return;
  clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = setTimeout(() => {
    console.log(`[${label}] Reconnecting now...`);
    startBot(entry.server);
  }, delay);
}

servers.forEach(startBot);

process.on('SIGINT', () => {
  console.log('Shutting down...');
  Object.values(bots).forEach(({ bot }) => bot && bot.quit());
  process.exit();
});
