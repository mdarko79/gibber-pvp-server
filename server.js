const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

// Socket.IO z CORS
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'https://www.goblingibber.com',
      'https://goblingibber.com',
      'https://goblingibber.vercel.app',
    ],
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.json());

// Store waiting players and active battles
const waitingPlayers = [];
const battles = {};

// Validate goblin asset
function validateGoblinAsset(goblinAsset) {
  const missingFields = [];
  if (!goblinAsset) missingFields.push('goblinAsset');
  if (!goblinAsset.id) missingFields.push('id');
  if (!goblinAsset.gibberish) missingFields.push('gibberish');
  if (!goblinAsset.audioUrl) missingFields.push('audioUrl');
  if (!goblinAsset.imageUrl) missingFields.push('imageUrl');
  if (
    !goblinAsset.stats ||
    typeof goblinAsset.stats !== 'object' ||
    !Number.isFinite(goblinAsset.stats.cringe) ||
    !Number.isFinite(goblinAsset.stats.chaos) ||
    !Number.isFinite(goblinAsset.stats.iq)
  ) {
    missingFields.push('stats');
  }
  if (!goblinAsset.timestamp) missingFields.push('timestamp');
  const isValid = missingFields.length === 0;
  if (!isValid) {
    console.warn('Invalid goblin asset:', {
      id: goblinAsset?.id,
      reason: `Missing or invalid fields: ${missingFields.join(', ')}`,
    });
  }
  return { isValid, missingFields };
}

// Apply status effects and return any new status effect for animation
function applyStatusEffects(battle, player, playerKey) {
  let statusEffect = null;
  if (player.status.type === 'poison' && player.status.lastTick <= Date.now() - 1000) {
    player.hp = Math.max(0, player.hp - 3);
    battle.log.push({
      message: `${playerKey} suffers 3 poison damage! 🤢`,
      timestamp: Date.now(),
    });
    statusEffect = 'poisoned';
    player.status.duration -= 1;
    player.status.lastTick = Date.now();
    if (player.status.duration <= 0) {
      player.status = { type: null, duration: 0, lastTick: 0 };
      battle.log.push({
        message: `${playerKey} recovers from poison!`,
        timestamp: Date.now(),
      });
    }
  } else if (player.status.type === 'weakness' && player.status.lastTick <= Date.now() - 1000) {
    player.status.duration -= 1;
    player.status.lastTick = Date.now();
    if (player.status.duration <= 0) {
      player.status = { type: null, duration: 0, lastTick: 0 };
      battle.log.push({
        message: `${playerKey} shakes off weakness! 😴`,
        timestamp: Date.now(),
      });
    }
  }
  return statusEffect;
}

// ⭐ NOWA FUNKCJA: Handle player attack
function handlePlayerAttack(battle, socketId, attackType, timingBonus) {
  const isPlayer1 = socketId === battle.player1.id;
  const attackerKey = isPlayer1 ? 'player1' : 'player2';
  const defenderKey = isPlayer1 ? 'player2' : 'player1';
  const attacker = battle[attackerKey];
  const defender = battle[defenderKey];

  // Check cooldown
  if (battle.cooldowns[attackerKey][attackType] > 0) {
    return { error: 'Attack on cooldown!' };
  }

  const attackerStats = attacker.goblinAsset.stats;
  const attackerStatus = attacker.status;
  const attackerName = isPlayer1 ? 'Player 1' : 'Player 2';
  const defenderName = isPlayer1 ? 'Player 2' : 'Player 1';

  let damage = 0;
  let statusEffect = null;
  let attackEffect = attackType;

  const timingMultiplier = timingBonus ? 1.5 : 1;
  const isCritical = Math.random() < 0.15;
  const critMultiplier = isCritical ? 2 : 1;

  // Calculate base cooldowns
  const baseCooldowns = { chaos: 3, iq: 5, cringe: 4 };
  const scaledCooldown = baseCooldowns[attackType] * (1 - attackerStats[attackType] / 200);

  // Calculate damage based on attack type
  if (attackType === 'chaos') {
    damage = Math.round(attackerStats.chaos * (0.4 + Math.random() * 0.2) * critMultiplier * timingMultiplier);
    battle.log.push({
      message: `${attackerName} unleashes CHAOS BLAST! 💥${isCritical ? ' Critical!' : ''}${timingBonus ? ' Perfect Timing!' : ''}`,
      timestamp: Date.now(),
    });
    // Poison chance
    if (Math.random() < 0.3 * timingMultiplier) {
      defender.status = { type: 'poison', duration: 2, lastTick: Date.now() };
      battle.log.push({
        message: `${defenderName} is poisoned! 🤢`,
        timestamp: Date.now(),
      });
      statusEffect = 'poisoned';
    }
  } else if (attackType === 'iq') {
    damage = Math.round(attackerStats.iq * 0.3 * critMultiplier * timingMultiplier);
    const blockAmount = Math.round(attackerStats.iq * 0.15);
    battle.log.push({
      message: `${attackerName} raises IQ SHIELD! 🛡️${isCritical ? ' Critical!' : ''}${timingBonus ? ' Perfect Timing!' : ''}`,
      timestamp: Date.now(),
    });
    battle.log.push({
      message: `${attackerName} blocks ${blockAmount} damage!`,
      timestamp: Date.now(),
    });
  } else if (attackType === 'cringe') {
    damage = Math.round(attackerStats.cringe * (0.6 + Math.random() * 0.15) * critMultiplier * timingMultiplier);
    battle.log.push({
      message: `${attackerName} emits CRINGE WAVE! 😆${isCritical ? ' Critical!' : ''}${timingBonus ? ' Perfect Timing!' : ''}`,
      timestamp: Date.now(),
    });
    // Weakness chance
    if (Math.random() < 0.2 * timingMultiplier) {
      defender.status = { type: 'weakness', duration: 1, lastTick: Date.now() };
      battle.log.push({
        message: `${defenderName} is weakened! 😖`,
        timestamp: Date.now(),
      });
      statusEffect = 'burn';
    }
  }

  // Apply weakness penalty
  if (attackerStatus.type === 'weakness') {
    damage = Math.round(damage * 0.7);
    battle.log.push({
      message: `${attackerName}'s attack is weakened! 😴`,
      timestamp: Date.now(),
    });
  }

  // Apply damage
  defender.hp = Math.max(0, defender.hp - damage);
  battle.log.push({
    message: `${defenderName} takes ${damage} damage! 💥`,
    timestamp: Date.now(),
  });

  // Set cooldown
  battle.cooldowns[attackerKey][attackType] = scaledCooldown;
  battle.lastAction = Date.now();

  return {
    success: true,
    damage,
    attackEffect,
    statusEffect,
    target: defenderKey,
  };
}

// Check for battle end
function checkBattleEnd(battle) {
  if (battle.player1.hp <= 0 || battle.player2.hp <= 0) {
    let result = '';
    if (battle.player1.hp <= 0 && battle.player2.hp <= 0) {
      result = 'Draw! Both goblins fainted!';
    } else if (battle.player1.hp <= 0) {
      result = 'Player 2 wins!';
    } else if (battle.player2.hp <= 0) {
      result = 'Player 1 wins!';
    }

    battle.log.push({ message: `Battle ends! ${result}`, timestamp: Date.now() });

    io.to(battle.player1.id).emit('battle-end', {
      result,
      player1: { ...battle.player1 },
      player2: { ...battle.player2 },
      log: battle.log,
    });
    io.to(battle.player2.id).emit('battle-end', {
      result,
      player1: { ...battle.player1 },
      player2: { ...battle.player2 },
      log: battle.log,
    });

    delete battles[battle.roomId];
    return true;
  }
  return false;
}

// Update battle state
function updateBattleState(roomId) {
  const battle = battles[roomId];
  if (!battle) return;

  // Update cooldowns
  ['player1', 'player2'].forEach((playerKey) => {
    Object.keys(battle.cooldowns[playerKey]).forEach((attackType) => {
      battle.cooldowns[playerKey][attackType] = Math.max(
        0,
        battle.cooldowns[playerKey][attackType] - 0.1
      );
    });
  });

  // Apply status effects
  const player1StatusEffect = applyStatusEffects(battle, battle.player1, 'Player 1');
  const player2StatusEffect = applyStatusEffects(battle, battle.player2, 'Player 2');

  // Update timing window
  battle.timingWindow = Math.random() < 0.2;

  // Check for battle end
  if (checkBattleEnd(battle)) {
    return; // Battle ended
  }

  // Emit update every 500ms
  if (!battle.lastUpdate || Date.now() - battle.lastUpdate >= 500) {
    io.to(battle.player1.id).emit('battle-update', {
      player1: { ...battle.player1 },
      player2: { ...battle.player2 },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: null,
      statusEffect: player2StatusEffect,
      target: player2StatusEffect ? 'opponent' : null,
      timingWindow: battle.timingWindow,
    });
    io.to(battle.player2.id).emit('battle-update', {
      player1: { ...battle.player1 },
      player2: { ...battle.player2 },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: null,
      statusEffect: player1StatusEffect,
      target: player1StatusEffect ? 'opponent' : null,
      timingWindow: battle.timingWindow,
    });
    battle.lastUpdate = Date.now();
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    waitingPlayers: waitingPlayers.length,
    activeBattles: Object.keys(battles).length,
    uptime: process.uptime(),
  });
});

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Game loop
  const gameLoop = setInterval(() => {
    Object.keys(battles).forEach((roomId) => {
      updateBattleState(roomId);
    });
  }, 100);

  socket.on('join-pvp', ({ goblinAsset }) => {
    const { isValid, missingFields } = validateGoblinAsset(goblinAsset);
    if (!isValid) {
      socket.emit('error', { message: `Invalid goblin asset: ${missingFields.join(', ')}` });
      return;
    }

    const existingPlayerIndex = waitingPlayers.findIndex((p) => p.id === socket.id);
    if (existingPlayerIndex !== -1) {
      waitingPlayers.splice(existingPlayerIndex, 1);
    }

    const player = {
      id: socket.id,
      goblinAsset,
      hp: 100,
      status: { type: null, duration: 0, lastTick: 0 },
      lastAction: Date.now(),
    };
    waitingPlayers.push(player);

    if (waitingPlayers.length >= 2) {
      const player1 = waitingPlayers.shift();
      const player2 = waitingPlayers.shift();
      const roomId = `${player1.id}-${player2.id}`;
      battles[roomId] = {
        roomId,
        player1,
        player2,
        log: [{ message: 'Epic battle begins! ⚔️', timestamp: Date.now() }],
        timingWindow: false,
        cooldowns: {
          player1: { chaos: 0, iq: 0, cringe: 0 },
          player2: { chaos: 0, iq: 0, cringe: 0 },
        },
        lastAction: Date.now(),
        lastUpdate: 0,
      };

      console.log(`[MATCH] Battle started: ${roomId}`);
      io.to(player1.id).emit('battle-start', { roomId, ...battles[roomId] });
      io.to(player2.id).emit('battle-start', { roomId, ...battles[roomId] });
    } else {
      socket.emit('waiting', { message: 'Waiting for an opponent...' });
    }
  });

  // ⭐ NOWY HANDLER: Player action
  socket.on('player-action', ({ roomId, attackType, timingBonus }) => {
    const battle = battles[roomId];
    if (!battle) {
      socket.emit('error', { message: 'Battle not found!' });
      return;
    }

    console.log(`[ACTION] ${socket.id} attacks with ${attackType} (timing: ${timingBonus})`);

    const result = handlePlayerAttack(battle, socket.id, attackType, timingBonus);

    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    // Broadcast immediate attack feedback
    const isPlayer1 = socket.id === battle.player1.id;
    io.to(battle.player1.id).emit('battle-update', {
      player1: { ...battle.player1 },
      player2: { ...battle.player2 },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: result.attackEffect,
      statusEffect: result.statusEffect,
      target: isPlayer1 ? 'opponent' : 'player',
      timingWindow: battle.timingWindow,
    });
    io.to(battle.player2.id).emit('battle-update', {
      player1: { ...battle.player1 },
      player2: { ...battle.player2 },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: result.attackEffect,
      statusEffect: result.statusEffect,
      target: isPlayer1 ? 'player' : 'opponent',
      timingWindow: battle.timingWindow,
    });

    // Check for battle end
    checkBattleEnd(battle);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    clearInterval(gameLoop);

    const playerIndex = waitingPlayers.findIndex((p) => p.id === socket.id);
    if (playerIndex !== -1) waitingPlayers.splice(playerIndex, 1);

    for (const roomId in battles) {
      const battle = battles[roomId];
      if (battle.player1.id === socket.id || battle.player2.id === socket.id) {
        const winnerId = battle.player1.id === socket.id ? battle.player2.id : battle.player1.id;
        io.to(winnerId).emit('battle-end', {
          result: 'Opponent disconnected! You win by default!',
          ...battle,
        });
        delete battles[roomId];
      }
    }
  });
});

// Inactivity timeout
setInterval(() => {
  Object.keys(battles).forEach((roomId) => {
    const battle = battles[roomId];
    if (Date.now() - battle.lastAction > 120000) {
      const result = 'Draw! Battle timed out due to inactivity.';
      io.to(battle.player1.id).emit('battle-end', { result, ...battle });
      io.to(battle.player2.id).emit('battle-end', { result, ...battle });
      delete battles[roomId];
      console.log(`[TIMEOUT] Battle ${roomId} ended`);
    }
  });
}, 30000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚔️ Duels PvP Server running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
});