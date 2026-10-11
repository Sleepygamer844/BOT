// bot.js — Render-friendly Mineflayer AFK bot
// Fixed:
// 1) Removed invalid "client: { brand: 'vanilla' }" option.
// 2) Uses the documented "brand" option.
// 3) Disables Mineflayer physics by default to avoid invalid movement kicks.
// 4) Removed physical jump/sneak/swing anti-AFK actions.
// 5) Safer reconnect handling (prevents duplicate reconnect loops).
// 6) Clears timers from old bot instances.
// 7) Keeps a Render HTTP health endpoint.
//
// Movement upgrade (connection code untouched):
// 8) Realistic "roam" AI — the bot permanently travels the world instead of
//    standing still. It keeps a slowly-drifting heading so it genuinely
//    explores instead of pacing in circles.
// 9) Smooth head turning instead of instant snapping, looks at nearby players,
//    faces the direction it walks, glances around while idle.
// 10) Stuck detection + automatic rerouting and un-sticking hops.
// 11) Occasional long expeditions (90-220 blocks) mixed with local strolls.
// 12) Roaming pauses instantly when combat starts and resumes afterwards.

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
// NOTE: physics MUST be enabled for the bot to walk around.
const DEFAULT_PHYSICS_ENABLED =
  String(process.env.PHYSICS_ENABLED || 'false').toLowerCase() === 'true';

// ── Movement / roaming tuning ─────────────────

const ROAM_ENABLED =
  String(
    process.env.ROAM_ENABLED ?? process.env.ENABLE_WANDER ?? 'true'
  ).toLowerCase() === 'true';

// Local stroll distance (blocks).
const ROAM_NEAR_MIN = Number(process.env.ROAM_NEAR_MIN || 12);
const ROAM_NEAR_MAX = Number(process.env.ROAM_NEAR_MAX || 45);

// Chance per leg of doing a long expedition instead.
const ROAM_FAR_CHANCE = Number(process.env.ROAM_FAR_CHANCE || 0.1);
const ROAM_FAR_MIN = Number(process.env.ROAM_FAR_MIN || 90);
const ROAM_FAR_MAX = Number(process.env.ROAM_FAR_MAX || 220);

// How long the bot stands still between legs (looks around like a player).
const ROAM_PAUSE_MIN_MS = Number(process.env.ROAM_PAUSE_MIN_MS || 1200);
const ROAM_PAUSE_MAX_MS = Number(process.env.ROAM_PAUSE_MAX_MS || 9000);

// Heading drift — this is what makes it explore the world instead of pacing.
const ROAM_TURN_CHANCE = Number(process.env.ROAM_TURN_CHANCE || 0.22);
const ROAM_TURN_MAX_RAD = Number(process.env.ROAM_TURN_MAX_RAD || 0.75);

// Stuck detection.
const ROAM_STUCK_MS = Number(process.env.ROAM_STUCK_MS || 4500);
const ROAM_JUMPING =
  String(process.env.ROAM_JUMPING || 'true').toLowerCase() === 'true';

// Look behaviour.
const LOOK_TICK_MS = Number(
  process.env.LOOK_TICK_MS || process.env.LOOK_INTERVAL_MS || 220
);
const LOOK_AT_PLAYER_CHANCE = Number(
  process.env.LOOK_AT_PLAYER_CHANCE || 0.5
);

const rand = (min, max) => min + Math.random() * (max - min);

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
        roaming: Boolean(entry.roam?.dest),
        heading: entry.roam
          ? Number(entry.roam.heading.toFixed(3))
          : null,
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
// MATH HELPERS
// ─────────────────────────────────────────────

// Shortest-path angular interpolation (handles the ±PI wrap).
function lerpAngle(from, to, t) {
  let d = to - from;
  d = (((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return from + d * t;
}

// Mineflayer yaw convention: atan2(-dx, -dz)  (matches bot.lookAt()).
const headingToYaw = (dx, dz) => Math.atan2(-dx, -dz);

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
      // Populated by startRoaming().
      roam: {
        busy: false,
        heading: 0,
        goalsSinceTurn: 0,
        stuckStreak: 0,
        dest: null,
      },
      // Populated by startNaturalLook().
      look: {
        yaw: 0,
        pitch: 0,
        targetYaw: 0,
        targetPitch: 0,
        nextPickAt: 0,
        lastPos: null,
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
  entry.roam.busy = false;
  entry.roam.dest = null;
  entry.generation += 1;

  const generation = entry.generation;

  const physicsEnabled =
    typeof server.physicsEnabled === 'boolean'
      ? server.physicsEnabled
      : DEFAULT_PHYSICS_ENABLED;

  // ── CONNECTION OPTIONS: unchanged ──────────
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
  // ───────────────────────────────────────────

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

      // Movement settings tuned for "walks around like a player".
      move.canDig = false;            // don't grief terrain
      move.allow1by1towers = false;   // don't pillar up
      move.allowParkour = false;      // avoid risky jumps/fall damage
      move.allowSprinting = true;     // real players sprint
      move.canOpenDoors = true;
      move.canOpenGates = true;
      move.allowFreeMotion = false;
      move.scafoldingBlocks = [];

      // Optional extras — harmless if the property name changed.
      try { move.liquidCost = 120; } catch {}
      try { move.maxDropDown = 3; } catch {}

      bot.pathfinder.setMovements(move);
    } catch (error) {
      console.error(`[${label}] Pathfinder setup failed: ${error.message}`);
    }

    startNaturalLook(entry, label, generation);

    if (ROAM_ENABLED && physicsEnabled) {
      startRoaming(entry, label, generation);
    } else if (ROAM_ENABLED && !physicsEnabled) {
      console.warn(
        `[${label}] Roaming is ON but physics is OFF — the bot cannot walk. ` +
        `Set PHYSICS_ENABLED=true (or "physicsEnabled": true on the server entry).`
      );
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

  // Stop roaming immediately so pathfinder isn't fighting the PvP plugin.
  try {
    bot.pathfinder.setGoal(null);
  } catch {}

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
// WALK HELPER (with timeout + stuck detection)
// ─────────────────────────────────────────────

function walkTo(entry, label, goal, timeoutMs, generation) {
  const bot = entry.bot;

  return new Promise((resolve) => {
    let settled = false;
    let lastPos = bot.entity ? bot.entity.position.clone() : null;
    let lastProgressAt = Date.now();

    const finish = (reason) => {
      if (settled) return;
      settled = true;

      clearTimeout(timeoutTimer);
      clearInterval(watchTimer);

      if (reason !== 'arrived') {
        try { bot.pathfinder.setGoal(null); } catch {}
      }

      resolve(reason);
    };

    const timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);

    const watchTimer = setInterval(() => {
      if (bots[label]?.generation !== generation) return finish('stale');
      if (!bot.entity) return finish('stale');

      // Combat always wins.
      if (entry.combat.target) return finish('interrupted');

      const pos = bot.entity.position;

      if (!lastPos) {
        lastPos = pos.clone();
        lastProgressAt = Date.now();
        return;
      }

      if (pos.distanceTo(lastPos) > 0.6) {
        lastPos = pos.clone();
        lastProgressAt = Date.now();
        return;
      }

      if (Date.now() - lastProgressAt > ROAM_STUCK_MS) finish('stuck');
    }, 1000);

    try {
      bot.pathfinder.goto(goal).then(
        () => finish('arrived'),
        () => finish('failed')
      );
    } catch {
      finish('failed');
    }
  });
}

// Small hop to un-stick the bot (real players do this too).
function hop(entry, label, generation) {
  const bot = entry.bot;
  if (!bot?.entity) return;

  try {
    bot.setControlState('jump', true);
    addTimeout(entry, () => {
      try { bot.setControlState('jump', false); } catch {}
    }, 260);
  } catch {}
}

// ─────────────────────────────────────────────
// ROAMING — the "real player" travel loop
// ─────────────────────────────────────────────

function startRoaming(entry, label, generation) {
  const roam = entry.roam;

  roam.busy = false;
  roam.heading = Math.random() * Math.PI * 2;
  roam.goalsSinceTurn = 0;
  roam.stuckStreak = 0;
  roam.dest = null;

  const step = async () => {
    const bot = entry.bot;

    if (!bot?.entity || bots[label]?.generation !== generation) return;
    if (roam.busy) { addTimeout(entry, step, 1000); return; }
    if (entry.combat.target) { addTimeout(entry, step, 1500); return; }

    roam.busy = true;
    let reason = 'failed';

    try {
      const far = Math.random() < ROAM_FAR_CHANCE;

      const distance = far
        ? rand(ROAM_FAR_MIN, ROAM_FAR_MAX)
        : rand(ROAM_NEAR_MIN, ROAM_NEAR_MAX);

      // Slowly drift the heading so the bot explores instead of pacing.
      roam.goalsSinceTurn += 1;
      if (roam.goalsSinceTurn >= 4 || Math.random() < ROAM_TURN_CHANCE) {
        roam.heading += rand(-ROAM_TURN_MAX_RAD, ROAM_TURN_MAX_RAD);
        roam.goalsSinceTurn = 0;
      }

      const pos = bot.entity.position;

      const tx = Math.floor(pos.x + Math.cos(roam.heading) * distance);
      const tz = Math.floor(pos.z + Math.sin(roam.heading) * distance);
      const ty = Math.floor(pos.y);

      roam.dest = { x: tx, y: ty, z: tz };

      reason = await walkTo(
        entry,
        label,
        new goals.GoalNear(tx, ty, tz, 2),
        far ? 150000 : 50000,
        generation
      );
    } finally {
      roam.busy = false;
      roam.dest = null;
    }

    if (bots[label]?.generation !== generation) return;

    if (
      reason === 'stuck' ||
      reason === 'failed' ||
      reason === 'timeout'
    ) {
      roam.stuckStreak += 1;

      // Turn sharply away from whatever is blocking the path.
      roam.heading += Math.PI / 2 + Math.random() * Math.PI;
      roam.goalsSinceTurn = 0;

      if (ROAM_JUMPING && reason === 'stuck') {
        hop(entry, label, generation);
      }

      console.log(`[${label}] Roam ${reason} — picking a new heading.`);
    } else {
      roam.stuckStreak = 0;
    }

    // Stand still for a moment — real players don't walk non-stop.
    const pause = roam.stuckStreak > 3
      ? rand(4000, 10000)
      : rand(ROAM_PAUSE_MIN_MS, ROAM_PAUSE_MAX_MS);

    addTimeout(entry, step, pause);
  };

  // Don't start walking the instant we spawn — look around first.
  addTimeout(entry, step, rand(3000, 6000));
}

// ─────────────────────────────────────────────
// NATURAL LOOK (replaces the old anti-AFK head snap)
// ─────────────────────────────────────────────

function startNaturalLook(entry, label, generation) {
  const look = entry.look;
  const bot0 = entry.bot;

  look.yaw = bot0?.entity?.yaw ?? 0;
  look.pitch = bot0?.entity?.pitch ?? 0;
  look.targetYaw = look.yaw;
  look.targetPitch = 0;
  look.nextPickAt = 0;
  look.lastPos = bot0?.entity ? bot0.entity.position.clone() : null;

  addInterval(entry, () => {
    const bot = entry.bot;
    if (!bot?.entity) return;
    if (bots[label]?.generation !== generation) return;

    const now = Date.now();
    const pos = bot.entity.position;

    // ── Are we walking? Then face the direction of travel. ──
    let moveYaw = null;

    if (look.lastPos) {
      const dx = pos.x - look.lastPos.x;
      const dz = pos.z - look.lastPos.z;

      if (dx * dx + dz * dz > 0.003) {
        moveYaw = headingToYaw(dx, dz);
      }
    }

    look.lastPos = pos.clone();

    // ── Periodically choose a new thing to look at. ──
    if (now >= look.nextPickAt) {
      const nearbyPlayer = bot.nearestEntity(
        (e) =>
          e.type === 'player' &&
          e !== bot.entity &&
          e.position.distanceTo(pos) < 18
      );

      if (nearbyPlayer && Math.random() < LOOK_AT_PLAYER_CHANCE) {
        const dx = nearbyPlayer.position.x - pos.x;
        const dz = nearbyPlayer.position.z - pos.z;
        const dy =
          nearbyPlayer.position.y + 1.5 - (pos.y + (bot.entity.height || 1.62));

        look.targetYaw = headingToYaw(dx, dz);
        look.targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
        look.nextPickAt = now + rand(900, 1800);
      } else if (moveYaw !== null) {
        look.targetYaw = moveYaw;
        look.targetPitch = rand(-0.12, 0.12);
        look.nextPickAt = now + 600;
      } else {
        // Idle: slowly drift the head somewhere new.
        look.targetYaw = look.yaw + rand(-1.4, 1.4);
        look.targetPitch = rand(-0.35, 0.25);
        look.nextPickAt = now + rand(2500, 7000);
      }
    }

    // ── Smoothly turn towards the target instead of snapping. ──
    const walking = moveYaw !== null;
    const yawSpeed = walking ? 0.45 : 0.18;
    const pitchSpeed = walking ? 0.4 : 0.2;

    look.yaw = lerpAngle(look.yaw, look.targetYaw, yawSpeed);
    look.pitch += (look.targetPitch - look.pitch) * pitchSpeed;

    try {
      bot.look(look.yaw, look.pitch, true);
    } catch {}
  }, Math.max(80, LOOK_TICK_MS));
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
