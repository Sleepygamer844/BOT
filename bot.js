// bot.js — Final version with robust ESM import
import { createBot } from 'mineflayer'; // ✅ CRITICAL FIX: Named import
import pathfinderPkg from 'mineflayer-pathfinder';
import pvpPkg from 'mineflayer-pvp';
import http from 'http';
import mcDataLoader from 'minecraft-data';

const { pathfinder, Movements, goals } = pathfinderPkg;
const { plugin: pvpPlugin } = pvpPkg;

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
  console.error('[Config] No servers configured. Set SERVERS env var as JSON.');
  process.exit(1);
}

// ─────────────────────────────────────────────
// HEALTH SERVER
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
const bots = {};
const combatState = {};

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bots: Object.keys(bots) }));
}).listen(port, () => console.log(`[Health] Listening on ${port}`));

// ─────────────────────────────────────────────
// BOT MANAGER
// ─────────────────────────────────────────────
function startBot(server) {
  const label = server.label || `${server.host}:${server.port}`;
  console.log(`[${label}] Connecting as ${server.username}...`);

  const bot = createBot({ // ✅ Using named import
    host: server.host,
    port: server.port,
    username: server.username,
    version: server.version,
    auth: server.auth || 'offline',
    client: { brand: 'vanilla' },
    hideErrors: true,
    viewDistance: 'normal',
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);

  bots[label] = { bot, server, reconnectTimer: null };
  combatState[label] = { target: null, until: 0 };

  // ── SPAWN ──
  bot.once('spawn', () => {
    console.log(`[${label}] ${bot.username} joined.`);

    const mcData = mcDataLoader(bot.version);
    const move = new Movements(bot, mcData);

    // Anti-kick movement config
    move.canDig = false;
    move.allow1by1towers = false;
    move.allowParkour = true;
    move.allowSprinting = true;
    move.canOpenDoors = true;
    move.canOpenGates = true;
    move.allowFreeMotion = false;   // 🚨 prevents "flying" flags
    move.scafoldingBlocks = [];

    bot.pathfinder.setMovements(move);

    setTimeout(() => {
      startAntiAFK(bot, label);
      startIdleWander(bot, label);
    }, 3000);
  });

  // ── CHAT COMMANDS ──
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    console.log(`[${label}] ${username}: ${message}`);

    if (/\b(fight me|1v1|come at me|pvp|duel|let'?s fight|fight)\b/i.test(message)
        && bot.players[username]) {
      startCombat(bot, label, username);
      return;
    }

    if (/\b(stop|enough|gg|peace|truce|calm down)\b/i.test(message)
        && combatState[label].target) {
      stopCombat(bot, label);
      bot.chat(`gg ${username}`);
      return;
    }

    if (/\b(come|follow|come here|come to me)\b/i.test(message)
        && bot.players[username]?.entity) {
      const target = bot.players[username].entity;
      bot.chat(`On my way, ${username}.`);
      try {
        await bot.pathfinder.goto(new goals.GoalNear(
          target.position.x, target.position.y, target.position.z, 2
        ));
      } catch {}
      return;
    }
  });

  // ── FIGHT BACK WHEN HIT ──
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    if (combatState[label].target) return;
    const attacker = bot.nearestEntity(e =>
      e.type === 'player' && e.username && e.username !== bot.username
    );
    if (attacker?.username) {
      console.log(`[${label}] Attacked — fighting back vs ${attacker.username}`);
      startCombat(bot, label, attacker.username, 8000);
    }
  });

  // ── RETREAT AT LOW HP ──
  bot.on('health', () => {
    const cs = combatState[label];
    if (cs.target && bot.health < 6) {
      console.log(`[${label}] Low HP (${bot.health}) — retreating.`);
      const target = cs.target;
      stopCombat(bot, label);
      try {
        const dx = bot.entity.position.x - (target?.position.x ?? bot.entity.position.x);
        const dz = bot.entity.position.z - (target?.position.z ?? bot.entity.position.z);
        bot.pathfinder.setGoal(new goals.GoalNear(
          bot.entity.position.x + dx * 3,
          bot.entity.position.y,
          bot.entity.position.z + dz * 3,
          1
        ));
      } catch {}
    }
  });

  // ── RECONNECT ──
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
// COMBAT
// ─────────────────────────────────────────────
function startCombat(bot, label, username, durationMs = 30000) {
  const target = bot.players[username]?.entity;
  if (!target) {
    bot.chat(`I don't see you, ${username}.`);
    return;
  }
  bot.chat(`Alright ${username}, let's go!`);
  bot.pvp.attack(target);
  combatState[label].target = target;
  combatState[label].until = Date.now() + durationMs;

  setTimeout(() => {
    if (combatState[label].until <= Date.now()) stopCombat(bot, label);
  }, durationMs + 100);
}

function stopCombat(bot, label) {
  try { bot.pvp.stop(); } catch {}
  combatState[label].target = null;
  combatState[label].until = 0;
}

// ─────────────────────────────────────────────
// ANTI-AFK
// ─────────────────────────────────────────────
function startAntiAFK(bot, label) {
  setInterval(() => {
    if (!bot.entity) return;
    if (Math.random() < 0.5) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400 + Math.random() * 200);
    }
  }, 40000 + Math.random() * 40000);

  setInterval(() => {
    if (!bot.entity) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
  }, 15000 + Math.random() * 30000);

  setInterval(() => {
    if (bot.entity && Math.random() < 0.4) bot.swingArm();
  }, 25000);

  setInterval(() => {
    if (!bot.entity) return;
    if (Math.random() < 0.3) {
      bot.setControlState('sneak', true);
      setTimeout(() => bot.setControlState('sneak', false), 500 + Math.random() * 1500);
    }
  }, 90000 + Math.random() * 60000);
}

// ─────────────────────────────────────────────
// IDLE WANDER
// ─────────────────────────────────────────────
function startIdleWander(bot, label) {
  const wander = async () => {
    if (!bot.entity || combatState[label].target) {
      return setTimeout(wander, 20000);
    }
    const nearbyPlayer = bot.nearestEntity(e =>
      e.type === 'player' && e.position.distanceTo(bot.entity.position) < 12
    );
    if (nearbyPlayer) return setTimeout(wander, 20000);

    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const dist = 3 + Math.random() * 5;
    const x = Math.floor(pos.x + Math.cos(angle) * dist);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z + Math.sin(angle) * dist);

    try {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
    } catch {}
    setTimeout(wander, 15000 + Math.random() * 25000);
  };
  setTimeout(wander, 10000);
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

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
servers.forEach(startBot);

process.on('SIGINT', () => {
  console.log('Shutting down...');
  Object.values(bots).forEach(({ bot }) => bot && bot.quit());
  process.exit();
});
