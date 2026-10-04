// bot.js — AFK Minecraft bot (no AI, lightweight, realistic movement)
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: pvpPlugin } = require('mineflayer-pvp');
const { plugin: autoEatPlugin } = require('mineflayer-auto-eat');
const http = require('http');
const mcDataLoader = require('minecraft-data');

// ─────────────────────────────────────────────
// CONFIG — from Render environment variables
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
// HEALTH SERVER — keeps Render awake
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bots: Object.keys(bots) }));
}).listen(port, () => console.log(`[Health] Listening on ${port}`));

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const bots = {};
const combatState = {};

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
    // ✅ physicsEnabled defaults to true — DO NOT set it to false
    client: { brand: 'vanilla' },
    hideErrors: true,
    viewDistance: 'normal',
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);
  bot.loadPlugin(autoEatPlugin);

  bots[label] = { bot, server, reconnectTimer: null };
  combatState[label] = { target: null, until: 0 };

  // ── SPAWN: configure movement & start behaviour ──
  bot.once('spawn', () => {
    console.log(`[${label}] ${bot.username} joined.`);

    const mcData = mcDataLoader(bot.version);
    const move = new Movements(bot, mcData);

    // Critical anti-kick settings — makes movement look vanilla
    move.canDig = false;               // don't break blocks while pathing
    move.allow1by1towers = false;      // no pillar-jumping
    move.allowParkour = true;          // jump gaps like a player
    move.allowSprinting = true;        // sprint when far
    move.canOpenDoors = true;
    move.canOpenGates = true;
    move.allowFreeMotion = false;      // 🚨 MUST be false — prevents flying flags
    move.scafoldingBlocks = [];        // no block placing for path

    bot.pathfinder.setMovements(move);

    // Auto-eat config — stops starvation death and "starving bot" flags
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 14,
      bannedFood: ['golden_apple', 'enchanted_golden_apple'],
    };

    // Delay actions to let pathfinder rules apply fully
    setTimeout(() => {
      startAntiAFK(bot, label);
      startIdleWander(bot, label);
    }, 3000);
  });

  // ── CHAT COMMANDS ──
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    console.log(`[${label}] ${username}: ${message}`);

    // PVP triggers
    const pvpTriggers = /\b(fight me|1v1|come at me|pvp|duel|let'?s fight|fight)\b/i;
    if (pvpTriggers.test(message) && bot.players[username]) {
      startCombat(bot, label, username);
      return;
    }

    // Stop fighting
    if (/\b(stop|enough|gg|peace|truce|calm down)\b/i.test(message) && combatState[label].target) {
      stopCombat(bot, label);
      bot.chat(`gg ${username}`);
      return;
    }

    // Follow / come
    if (/\b(come|follow|come here|come to me)\b/i.test(message) && bot.players[username]?.entity) {
      const target = bot.players[username].entity;
      bot.chat(`On my way, ${username}.`);
      try {
        await bot.pathfinder.goto(new goals.GoalNear(
          target.position.x, target.position.y, target.position.z, 2
        ));
      } catch (e) { /* unreachable */ }
      return;
    }
  });

  // ── REACT TO BEING ATTACKED ──
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    if (combatState[label].target) return;
    const attacker = bot.nearestEntity(e =>
      e.type === 'player' && e.username && e.username !== bot.username
    );
    if (attacker && attacker.username) {
      console.log(`[${label}] Attacked — fighting back vs ${attacker.username}`);
      startCombat(bot, label, attacker.username, 8000);
    }
  });

  // ── LOW HP RETREAT ──
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

  // ── RECONNECT LOGIC ──
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
// COMBAT HELPERS
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
    if (combatState[label].until <= Date.now()) {
      stopCombat(bot, label);
    }
  }, durationMs + 100);
}

function stopCombat(bot, label) {
  try { bot.pvp.stop(); } catch {}
  combatState[label].target = null;
  combatState[label].until = 0;
}

// ─────────────────────────────────────────────
// ANTI-AFK — lightweight, realistic
// ─────────────────────────────────────────────
function startAntiAFK(bot, label) {
  // Occasional jump
  setInterval(() => {
    if (!bot.entity) return;
    if (Math.random() < 0.5) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 400 + Math.random() * 200);
    }
  }, 40000 + Math.random() * 40000);

  // Smooth look rotation (false = smooth, avoids anti-cheat flags)
  setInterval(() => {
    if (!bot.entity) return;
    bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
  }, 15000 + Math.random() * 30000);

  // Idle arm swing
  setInterval(() => {
    if (bot.entity && Math.random() < 0.4) bot.swingArm();
  }, 25000);

  // Occasional sneak toggle
  setInterval(() => {
    if (!bot.entity) return;
    if (Math.random() < 0.3) {
      bot.setControlState('sneak', true);
      setTimeout(() => bot.setControlState('sneak', false), 500 + Math.random() * 1500);
    }
  }, 90000 + Math.random() * 60000);
}

// ─────────────────────────────────────────────
// IDLE WANDER — real walking via pathfinder
// ─────────────────────────────────────────────
function startIdleWander(bot, label) {
  const wander = async () => {
    if (!bot.entity || combatState[label].target) {
      return setTimeout(wander, 20000);
    }
    // Don't wander if a player is nearby — looks suspicious
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
    } catch { /* ignore unreachable */ }
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
