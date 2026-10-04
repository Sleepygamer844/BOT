// bot.js — Render-friendly Mineflayer AFK bot
// Fixed:
// 1) Removed invalid "client: { brand: 'vanilla' }" option.
// 2) Uses the documented "brand" option.
// 3) Disables Mineflayer physics by default to avoid invalid movement kicks.
// 4) Removed physical jump/sneak/swing anti-AFK actions.
// 5) Safer reconnect handling (prevents duplicate reconnect loops).
// 6) Clears timers from old bot instances.
// 7) Keeps a Render HTTP health endpoint.

import { createBot } from 'mineflayer';
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

  if (!Array.isArray(servers)) {
    throw new Error('SERVERS must be a JSON array.');
  }
} catch (error) {
  console.error('[Config] Failed to parse SERVERS:', error.message);
  process.exit(1);
}

if (servers.length === 0) {
  console.error('[Config] No servers configured. Set SERVERS env var as JSON.');
  process.exit(1);
}

// Defaults are deliberately conservative for AFK use.
const DEFAULT_PHYSICS_ENABLED =
  String(process.env.PHYSICS_ENABLED || 'false').toLowerCase() === 'true';

const ENABLE_WANDER =
  String(process.env.ENABLE_WANDER || 'false').toLowerCase() === 'true';

const LOOK_INTERVAL_MS = Number(process.env.LOOK_INTERVAL_MS || 30000);

// ─────────────────────────────────────────────
// HEALTH SERVER (needed by Render Web Service)
// ─────────────────────────────────────────────

const port = Number(process.env.PORT || 3000);
const bots = {};

http
  .createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });

    const status = {};

    for (const [label, entry] of Object.entries(bots)) {
      status[label] = {
        username: entry.bot?.username || entry.server.username,
        connected: Boolean(entry.bot?.entity),
        host: entry.server.host,
        port: entry.server.port || 25565,
      };
    }

    res.end(
      JSON.stringify({
        status: 'ok',
        bots: status,
        uptimeSeconds: Math.floor(process.uptime()),
      })
    );
  })
  .listen(port, '0.0.0.0', () => {
    console.log(`[Health] Listening on ${port}`);
  });

// ─────────────────────────────────────────────
// TIMER HELPERS
// ─────────────────────────────────────────────

function clearEntryTimers(entry) {
  if (!entry) return;

  for (const timer of entry.timers.intervals) {
    clearInterval(timer);
  }

  for (const timer of entry.timers.timeouts) {
    clearTimeout(timer);
  }

  entry.timers.intervals.clear();
  entry.timers.timeouts.clear();
}

function addInterval(entry, callback, delay) {
  const timer = setInterval(callback, delay);
  entry.timers.intervals.add(timer);
  return timer;
}

function addTimeout(entry, callback, delay) {
  const timer = setTimeout(() => {
    entry.timers.timeouts.delete(timer);
    callback();
  }, delay);

  entry.timers.timeouts.add(timer);
  return timer;
}

// ─────────────────────────────────────────────
// RECONNECT
// ─────────────────────────────────────────────

function scheduleReconnect(label, delay, generation) {
  const entry = bots[label];

  if (!entry) return;
  if (entry.generation !== generation) return;
  if (entry.reconnectTimer) return;

  console.log(`[${label}] Reconnecting in ${Math.round(delay / 1000)}s...`);

  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;

    if (bots[label] !== entry) return;
    if (entry.generation !== generation) return;

    console.log(`[${label}] Reconnecting now...`);
    startBot(entry.server);
  }, delay);
}

// ─────────────────────────────────────────────
// BOT MANAGER
// ─────────────────────────────────────────────

function startBot(server) {
  const label = String(
    server.label || `${server.host}:${server.port || 25565}`
  );

  let entry = bots[label];

  if (!entry) {
    entry = {
      bot: null,
      server,
      reconnectTimer: null,
      generation: 0,
      timers: {
        intervals: new Set(),
        timeouts: new Set(),
      },
      combat: {
        target: null,
        until: 0,
      },
    };

    bots[label] = entry;
  }

  // Replace the old bot cleanly.
  clearEntryTimers(entry);

  if (entry.bot) {
    try {
      entry.bot.removeAllListeners();
      entry.bot.quit();
    } catch {}
  }

  entry.server = server;
  entry.bot = null;
  entry.combat.target = null;
  entry.combat.until = 0;
  entry.generation += 1;

  const generation = entry.generation;

  const physicsEnabled =
    typeof server.physicsEnabled === 'boolean'
      ? server.physicsEnabled
      : DEFAULT_PHYSICS_ENABLED;

  const options = {
    host: server.host,
    port: Number(server.port || 25565),
    username: server.username,
    auth: server.auth || 'offline',

    // IMPORTANT:
    // "client" must be a real minecraft-protocol client object.
    // Do NOT put { brand: 'vanilla' } in "client".
    brand: server.brand || 'vanilla',

    hideErrors: false,
    logErrors: true,
    viewDistance: server.viewDistance || 'normal',
    physicsEnabled,
    keepAlive: true,
    checkTimeoutInterval: 30000,
  };

  // Only provide "version" when it is actually configured.
  // Otherwise Mineflayer can attempt to detect it.
  if (server.version) {
    options.version = server.version;
  }

  console.log(
    `[${label}] Connecting as ${server.username} ` +
    `(physics=${physicsEnabled})...`
  );

  let bot;

  try {
    bot = createBot(options);
  } catch (error) {
    console.error(`[${label}] createBot failed: ${error.stack || error}`);
    scheduleReconnect(label, 15000, generation);
    return;
  }

  entry.bot = bot;

  // Load plugins.
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);

  // ───────────────────────────────────────────
  // SPAWN
  // ───────────────────────────────────────────

  bot.once('spawn', () => {
    // Ignore events from an obsolete bot generation.
    if (bots[label]?.generation !== generation) return;

    console.log(`[${label}] ${bot.username} joined.`);

    try {
      const mcData = mcDataLoader(bot.version);
      const move = new Movements(bot, mcData);

      // Conservative movement settings.
      move.canDig = false;
      move.allow1by1towers = false;
      move.allowParkour = false;
      move.allowSprinting = false;
      move.canOpenDoors = true;
      move.canOpenGates = true;
      move.allowFreeMotion = false;
      move.scafoldingBlocks = [];

      bot.pathfinder.setMovements(move);
    } catch (error) {
      console.error(`[${label}] Pathfinder setup failed: ${error.message}`);
    }

    startAntiAFK(entry, label, generation);

    if (ENABLE_WANDER && physicsEnabled) {
      startIdleWander(entry, label, generation);
    }
  });

  // ───────────────────────────────────────────
  // CHAT COMMANDS
  // ───────────────────────────────────────────

  bot.on('chat', async (username, message) => {
    if (bots[label]?.generation !== generation) return;
    if (username === bot.username) return;

    console.log(`[${label}] ${username}: ${message}`);

    if (
      /\b(fight me|1v1|come at me|pvp|duel|let'?s fight|fight)\b/i.test(
        message
      ) &&
      bot.players[username]
    ) {
      startCombat(bot, entry, label, username);
      return;
    }

    if (
      /\b(stop|enough|gg|peace|truce|calm down)\b/i.test(message) &&
      entry.combat.target
    ) {
      stopCombat(bot, entry, label);
      bot.chat(`gg ${username}`);
      return;
    }

    if (
      /\b(come|follow|come here|come to me)\b/i.test(message) &&
      bot.players[username]?.entity &&
      physicsEnabled
    ) {
      const target = bot.players[username].entity;
      bot.chat(`On my way, ${username}.`);

      try {
        await bot.pathfinder.goto(
          new goals.GoalNear(
            target.position.x,
            target.position.y,
            target.position.z,
            2
          )
        );
      } catch {}
    }
  });

  // ───────────────────────────────────────────
  // FIGHT BACK WHEN HIT
  // ───────────────────────────────────────────

  bot.on('entityHurt', (entity) => {
    if (bots[label]?.generation !== generation) return;
    if (entity !== bot.entity) return;
    if (entry.combat.target) return;

    const attacker = bot.nearestEntity(
      (e) =>
        e.type === 'player' &&
        e.username &&
        e.username !== bot.username
    );

    if (attacker?.username && physicsEnabled) {
      console.log(
        `[${label}] Attacked — fighting back vs ${attacker.username}`
      );

      startCombat(bot, entry, label, attacker.username, 8000);
    }
  });

  // ───────────────────────────────────────────
  // RETREAT AT LOW HP
  // ───────────────────────────────────────────

  bot.on('health', () => {
    if (bots[label]?.generation !== generation) return;

    const combat = entry.combat;

    if (combat.target && bot.health < 6 && physicsEnabled) {
      console.log(`[${label}] Low HP (${bot.health}) — retreating.`);

      const target = combat.target;
      stopCombat(bot, entry, label);

      try {
        const dx =
          bot.entity.position.x -
          (target?.position.x ?? bot.entity.position.x);

        const dz =
          bot.entity.position.z -
          (target?.position.z ?? bot.entity.position.z);

        bot.pathfinder.setGoal(
          new goals.GoalNear(
            bot.entity.position.x + dx * 3,
            bot.entity.position.y,
            bot.entity.position.z + dz * 3,
            1
          )
        );
      } catch {}
    }
  });

  // ───────────────────────────────────────────
  // DISCONNECT / KICK / ERROR
  // ───────────────────────────────────────────

  bot.once('kicked', (reason) => {
    if (bots[label]?.generation !== generation) return;

    console.log(
      `[${label}] Kicked: ${JSON.stringify(reason)}`
    );

    clearEntryTimers(entry);
    scheduleReconnect(label, 30000, generation);
  });

  bot.once('end', (reason) => {
    if (bots[label]?.generation !== generation) return;

    console.log(`[${label}] Disconnected: ${reason || 'socket closed'}`);

    clearEntryTimers(entry);
    scheduleReconnect(label, 10000, generation);
  });

  bot.on('error', (error) => {
    if (bots[label]?.generation !== generation) return;
    console.error(`[${label}] Error: ${error.message}`);
  });
}

// ─────────────────────────────────────────────
// COMBAT
// ─────────────────────────────────────────────

function startCombat(
  bot,
  entry,
  label,
  username,
  durationMs = 30000
) {
  const target = bot.players[username]?.entity;

  if (!target) {
    bot.chat(`I don't see you, ${username}.`);
    return;
  }

  bot.chat(`Alright ${username}, let's go!`);

  try {
    bot.pvp.attack(target);
  } catch (error) {
    console.error(`[${label}] PvP attack failed: ${error.message}`);
    return;
  }

  entry.combat.target = target;
  entry.combat.until = Date.now() + durationMs;

  addTimeout(entry, () => {
    if (entry.combat.until <= Date.now()) {
      stopCombat(bot, entry, label);
    }
  }, durationMs + 100);
}

function stopCombat(bot, entry, label) {
  try {
    bot.pvp.stop();
  } catch {}

  entry.combat.target = null;
  entry.combat.until = 0;

  console.log(`[${label}] Combat stopped.`);
}

// ─────────────────────────────────────────────
// ANTI-AFK
// ─────────────────────────────────────────────

function startAntiAFK(entry, label, generation) {
  // Head rotation is much safer than forcing physical movement.
  // Do not add jump/sneak/sprint packets here unless your server requires it.
  addInterval(
    entry,
    () => {
      const bot = entry.bot;

      if (!bot || !bot.entity) return;
      if (bots[label]?.generation !== generation) return;

      try {
        bot.look(
          Math.random() * Math.PI * 2,
          (Math.random() - 0.5) * 0.35,
          true
        );
      } catch {}
    },
    Math.max(10000, LOOK_INTERVAL_MS)
  );
}

// ─────────────────────────────────────────────
// OPTIONAL IDLE WANDER
// ─────────────────────────────────────────────

function startIdleWander(entry, label, generation) {
  const wander = async () => {
    const bot = entry.bot;

    if (!bot?.entity) {
      addTimeout(entry, wander, 20000);
      return;
    }

    if (bots[label]?.generation !== generation) return;
    if (entry.combat.target) {
      addTimeout(entry, wander, 20000);
      return;
    }

    const nearbyPlayer = bot.nearestEntity(
      (entity) =>
        entity.type === 'player' &&
        entity.position.distanceTo(bot.entity.position) < 12
    );

    if (nearbyPlayer) {
      addTimeout(entry, wander, 20000);
      return;
    }

    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const distance = 3 + Math.random() * 5;

    const x = Math.floor(pos.x + Math.cos(angle) * distance);
    const y = Math.floor(pos.y);
    const z = Math.floor(pos.z + Math.sin(angle) * distance);

    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(x, y, z, 1)
      );
    } catch {}

    addTimeout(
      entry,
      wander,
      15000 + Math.random() * 25000
    );
  };

  addTimeout(entry, wander, 10000);
}

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

for (const server of servers) {
  if (!server?.host || !server?.username) {
    console.error(
      '[Config] Skipping invalid server entry:',
      JSON.stringify(server)
    );
    continue;
  }

  startBot(server);
}

// ─────────────────────────────────────────────
// SHUTDOWN
// ─────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[System] ${signal} received. Shutting down...`);

  for (const entry of Object.values(bots)) {
    clearEntryTimers(entry);

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    try {
      entry.bot?.quit();
    } catch {}
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
