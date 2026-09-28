// bot.js
const mineflayer = require('mineflayer');
const { pathfinder, goals } = require('mineflayer-pathfinder');
const http = require('http');

const config = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'AFKBot',
  version: process.env.MC_VERSION || '1.20.1',
  auth: process.env.MC_AUTH || 'offline',
};

let bot;
let reconnectTimer;
let healthServer;

function createBot() {
  console.log(`[Bot] Connecting to ${config.host}:${config.port} as ${config.username}...`);
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth,
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log(`[Bot] ${bot.username} joined.`);
    startAntiAFK();
    startSimpleTasks();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log(`[Chat] ${username}: ${message}`);
    if (message.toLowerCase().includes('come')) {
      const player = bot.players[username]?.entity;
      if (player) {
        bot.chat(`Coming, ${username}!`);
        const { GoalNear } = goals;
        bot.pathfinder.setGoal(new GoalNear(player.position.x, player.position.y, player.position.z, 1));
      }
    }
  });

  bot.on('end', (reason) => {
    console.log(`[Bot] Disconnected: ${reason}. Reconnecting in 10s...`);
    scheduleReconnect(10000);
  });

  bot.on('kicked', (reason) => {
    console.log(`[Bot] Kicked: ${JSON.stringify(reason)}. Reconnecting in 30s...`);
    scheduleReconnect(30000);
  });

  bot.on('error', (err) => {
    console.error('[Bot] Error:', err.message);
  });
}

function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(createBot, delay);
}

function startAntiAFK() {
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

function startSimpleTasks() {
  setInterval(() => {
    if (bot) bot.swingArm();
  }, 30000);
}

function startHealthServer() {
  const port = process.env.PORT || 3000;
  healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running.\n');
  });
  healthServer.listen(port, () => {
    console.log(`[Health] Listening on port ${port}`);
  });
}

startHealthServer();
createBot();

process.on('SIGINT', () => {
  console.log('[Bot] Shutting down...');
  if (bot) bot.quit();
  if (healthServer) healthServer.close();
  process.exit();
});
