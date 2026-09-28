// bot.js
const mineflayer = require('mineflayer');
const { pathfinder, goals } = require('mineflayer-pathfinder');
const http = require('http');

// --- CONFIG: array of servers ---
// Loaded from env var SERVERS (JSON) or falls back to defaults
let servers = [];
try {
  servers = JSON.parse(process.env.SERVERS || '[]');
} catch (e) {
  console.error('[Config] Failed to parse SERVERS env var:', e.message);
}

if (servers.length === 0) {
  console.error('[Config] No servers configured. Set SERVERS env var as JSON.');
  process.exit(1);
}

// --- HEALTH SERVER (keeps Render awake) ---
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bots: servers.map(s => ({ host: s.host, username: s.username })),
  }));
}).listen(port, () => console.log(`[Health] Listening on port ${port}`));

// --- BOT MANAGER ---
const bots = {}; // key = server label

function startBot(server) {
  const label = server.label || `${server.host}:${server.port}`;
  console.log(`[${label}] Connecting as ${server.username}...`);

  const bot = mineflayer.createBot({
    host: server.host,
    port: server.port,
    username: server.username,
    version: server.version,
    auth: server.auth || 'offline',
  });

  bot.loadPlugin(pathfinder);
  bots[label] = { bot, server, reconnectTimer: null };

  bot.once('spawn', () => {
    console.log(`[${label}] ${bot.username} joined.`);
    startAntiAFK(bot, label);
    startSimpleTasks(bot, label);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log(`[${label}] ${username}: ${message}`);
    if (message.toLowerCase().includes('come')) {
      const player = bot.players[username]?.entity;
      if (player) {
        bot.chat(`Coming, ${username}!`);
        const { GoalNear } = goals;
        bot.pathfinder.setGoal(new GoalNear(
          player.position.x, player.position.y, player.position.z, 1
        ));
      }
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

  bot.on('error', (err) => {
    console.error(`[${label}] Error: ${err.message}`);
  });
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

function startAntiAFK(bot, label) {
  setInterval(() => {
    if (bot && bot.entity) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
    }
  }, 45000);

  setInterval(() => {
    if (bot && bot.entity) {
      bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true);
    }
  }, 60000);
}

function startSimpleTasks(bot, label) {
  setInterval(() => {
    if (bot) bot.swingArm();
  }, 30000);
}

// --- BOOT ALL BOTS ---
servers.forEach(startBot);

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', () => {
  console.log('Shutting down...');
  Object.values(bots).forEach(({ bot }) => bot && bot.quit());
  process.exit();
});
