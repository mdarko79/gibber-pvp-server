const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

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
      address: goblinAsset?.address,
      reason: `Missing or invalid fields: ${missingFields.join(', ')}`,
      goblinAsset,
    });
  }
  return { isValid, missingFields };
}

// Apply status effects and return any new status effect for animation
function applyStatusEffects(battle, player, playerKey, opponentKey) {
  let statusEffect = null;
  if (player.status.type === 'poison' && player.status.lastTick <= Date.now() - 1000) {
    player.hp = Math.max(0, player.hp - 3); // Reduced poison damage to 3 HP/sec
    battle.log.push({
      message: `${playerKey} suffers 3 poison damage! 🤢`,
      timestamp: Date.now(),
    });
    console.log(`Applied poison to ${playerKey}: HP=${player.hp}, Duration=${player.status.duration}`);
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
    console.log(`Applied weakness tick to ${playerKey}: Duration=${player.status.duration}`);
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

// Update battle state and emit updates (throttled to 500ms)
function updateBattleState(roomId) {
  const battle = battles[roomId];
  if (!battle) return;

  // Update cooldowns
  ['player1', 'player2'].forEach((playerKey) => {
    Object.keys(battle.cooldowns[playerKey]).forEach((attackType) => {
      battle.cooldowns[playerKey][attackType] = Math.max(0, battle.cooldowns[playerKey][attackType] - 0.1);
    });
  });

  // Apply status effects
  const player1StatusEffect = applyStatusEffects(battle, battle.player1, 'Player 1', 'Player 2');
  const player2StatusEffect = applyStatusEffects(battle, battle.player2, 'Player 2', 'Player 1');

  // Update timing window
  battle.timingWindow = Math.random() < 0.2;

  // Throttle updates to every 500ms
  if (!battle.lastUpdate || Date.now() - battle.lastUpdate >= 500) {
    console.log(`Emitting battle-update: ${roomId}, Player1 HP=${battle.player1.hp}, Player2 HP=${battle.player2.hp}, Status1=${battle.player1.status.type}, Status2=${battle.player2.status.type}`);
    io.to(battle.player1.id).emit('battle-update', {
      player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
      player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: null,
      statusEffect: player2StatusEffect,
      target: player2StatusEffect ? 'opponent' : null,
      timingWindow: battle.timingWindow,
    });
    io.to(battle.player2.id).emit('battle-update', {
      player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
      player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: null,
      statusEffect: player1StatusEffect,
      target: player1StatusEffect ? 'opponent' : null,
      timingWindow: battle.timingWindow,
    });
    battle.lastUpdate = Date.now();
  }

  // Check for battle end
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
    console.log(`Battle ended: ${roomId}, Result: ${result}, Player1 HP=${battle.player1.hp}, Player2 HP=${battle.player2.hp}`);

    io.to(battle.player1.id).emit('battle-end', {
      result,
      player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
      player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
      log: battle.log,
    });
    io.to(battle.player2.id).emit('battle-end', {
      result,
      player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
      player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
      log: battle.log,
    });

    delete battles[roomId];
  }
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Start a game loop for all active battles
  const gameLoop = setInterval(() => {
    Object.keys(battles).forEach((roomId) => {
      updateBattleState(roomId);
    });
  }, 100);

  socket.on('join-pvp', ({ goblinAsset }) => {
    console.log('Join-pvp received:', { socketId: socket.id, goblinAsset });

    // Validate goblin asset
    const { isValid, missingFields } = validateGoblinAsset(goblinAsset);
    if (!isValid) {
      socket.emit('error', { message: `Invalid goblin asset! Missing or invalid fields: ${missingFields.join(', ')}` });
      return;
    }

    // Check if player is already in waiting list to prevent duplicates
    const existingPlayerIndex = waitingPlayers.findIndex((p) => p.id === socket.id);
    if (existingPlayerIndex !== -1) {
      console.warn('Player already in waiting list:', socket.id);
      waitingPlayers.splice(existingPlayerIndex, 1);
    }

    // Add player to waiting list
    const player = { id: socket.id, goblinAsset, hp: 100, status: { type: null, duration: 0, lastTick: 0 }, lastAction: Date.now() };
    waitingPlayers.push(player);
    console.log('Player added to waiting list:', { socketId: socket.id, waitingPlayers: waitingPlayers.length });

    // Check if enough players to start a battle
    if (waitingPlayers.length >= 2) {
      const player1 = waitingPlayers.shift();
      const player2 = waitingPlayers.shift();
      const roomId = `${player1.id}-${player2.id}`;
      battles[roomId] = {
        player1: { ...player1, socket },
        player2: { ...player2, socket },
        log: [{ message: 'Epic battle begins! ⚔️', timestamp: Date.now() }],
        timing窓: false,
        cooldowns: {
          player1: { chaos: 0, iq: 0, cringe: 0 },
          player2: { chaos: 0, iq: 0, cringe: 0 },
        },
        lastAction: Date.now(),
        lastUpdate: 0,
      };

      console.log('Battle started:', { roomId, player1Id: player1.id, player2Id: player2.id });

      io.to(player1.id).emit('battle-start', {
        roomId,
        player1: { id: player1.id, goblinAsset: player1.goblinAsset, hp: player1.hp, status: player1.status },
        player2: { id: player2.id, goblinAsset: player2.goblinAsset, hp: player2.hp, status: player2.status },
        log: battles[roomId].log,
      });
      io.to(player2.id).emit('battle-start', {
        roomId,
        player1: { id: player1.id, goblinAsset: player1.goblinAsset, hp: player1.hp, status: player1.status },
        player2: { id: player2.id, goblinAsset: player2.goblinAsset, hp: player2.hp, status: player2.status },
        log: battles[roomId].log,
      });
    } else {
      socket.emit('waiting', { message: 'Waiting for an opponent to join the battle...' });
      console.log('Player waiting:', { socketId: socket.id });
    }
  });

  socket.on('player-action', ({ roomId, attackType, timingBonus }) => {
    console.log('Player action:', { roomId, attackType, socketId: socket.id, timingBonus });
    const battle = battles[roomId];
    if (!battle) {
      socket.emit('error', { message: 'Battle not found!' });
      console.warn('Battle not found:', { roomId, socketId: socket.id });
      return;
    }

    const isPlayer1 = socket.id === battle.player1.id;
    const attacker = isPlayer1 ? battle.player1 : battle.player2;
    const defender = isPlayer1 ? battle.player2 : battle.player1;
    const attackerStats = attacker.goblinAsset.stats;
    const baseCooldowns = { chaos: 4, iq: 6, cringe: 5 }; // Increased cooldowns
    const scaledCooldowns = {
      chaos: baseCooldowns.chaos * (1 - attackerStats.chaos / 200),
      iq: baseCooldowns.iq * (1 - attackerStats.iq / 200),
      cringe: baseCooldowns.cringe * (1 - attackerStats.cringe / 200),
    };

    // Check cooldown
    if (battle.cooldowns[isPlayer1 ? 'player1' : 'player2'][attackType] > 0) {
      socket.emit('error', { message: `Attack ${attackType} is on cooldown!` });
      console.warn('Attack on cooldown:', { attackType, socketId: socket.id });
      return;
    }

    // Update last action timestamp
    battle.lastAction = Date.now();

    // Calculate damage
    const timingMultiplier = timingBonus ? 1.5 : 1;
    const isCritical = Math.random() < 0.15;
    const critMultiplier = isCritical ? 2 : 1;
    let damage = 0;
    let statusEffect = null;

    if (attackType === 'chaos') {
      damage = Math.round(attackerStats.chaos * (0.3 + Math.random() * 0.15) * critMultiplier * timingMultiplier); // Reduced base damage
      battle.log.push({
        message: `${isPlayer1 ? 'Player 1' : 'Player 2'} unleashes CHAOS BLAST! 💥${isCritical ? ' Critical!' : ''}${timingBonus ? ' Perfect Timing!' : ''}`,
        timestamp: Date.now(),
      });
      if (Math.random() < 0.3 * timingMultiplier) {
        defender.status = { type: 'poison', duration: 2, lastTick: Date.now() };
        battle.log.push({ message: `${isPlayer1 ? 'Player 2' : 'Player 1'} is poisoned! 🤢`, timestamp: Date.now() });
        statusEffect = 'poisoned';
      }
    } else if (attackType === 'iq') {
      damage = Math.round(attackerStats.iq * 0.2 * critMultiplier * timingMultiplier); // Reduced base damage
      battle.log.push({
        message: `${isPlayer1 ? 'Player 1' : 'Player 2'} raises IQ SHIELD! 🛡️${isCritical ? ' Critical!' : ''}${timingBonus ? ' Perfect Timing!' : ''}`,
        timestamp: Date.now(),
      });
      battle.log.push({
        message: `${isPlayer1 ? 'Player 1' : 'Player 2'} blocks ${Math.round(attackerStats.iq * 0.1)} damage!`,
        timestamp: Date.now(),
      });
    } else if (attackType === 'cringe') {
      damage = Math.round(attackerStats.cringe * (0.4 + Math.random() * 0.1) * critMultiplier * timingMultiplier); // Reduced base damage
      battle.log.push({
        message: `${isPlayer1 ? 'Player 1' : 'Player 2'} emits CRINGE WAVE! 😆${isCritical ? ' Critical!' : ''}${timingBonus ? ' Perfect Timing!' : ''}`,
        timestamp: Date.now(),
      });
      if (Math.random() < 0.2 * timingMultiplier) {
        defender.status = { type: 'weakness', duration: 2, lastTick: Date.now() }; // Increased weakness duration
        battle.log.push({ message: `${isPlayer1 ? 'Player 2' : 'Player 1'} is weakened! 😖`, timestamp: Date.now() });
        statusEffect = 'burn';
      }
    }

    // Apply weakness effect
    if (attacker.status.type === 'weakness') {
      damage = Math.round(damage * 0.7);
      battle.log.push({
        message: `${isPlayer1 ? 'Player 1' : 'Player 2'}'s attack is weakened! 😴`,
        timestamp: Date.now(),
      });
    }

    // Update defender HP
    defender.hp = Math.max(0, defender.hp - damage);
    battle.log.push({
      message: `${isPlayer1 ? 'Player 2' : 'Player 1'} takes ${damage} damage! 💥`,
      timestamp: Date.now(),
    });
    console.log(`Attack processed: ${isPlayer1 ? 'Player 1' : 'Player 2'} deals ${damage} damage to ${isPlayer1 ? 'Player 2' : 'Player 1'}, HP=${defender.hp}, Critical=${isCritical}, TimingBonus=${timingBonus}`);

    // Set cooldown
    battle.cooldowns[isPlayer1 ? 'player1' : 'player2'][attackType] = scaledCooldowns[attackType];

    // Emit battle update immediately after action
    io.to(battle.player1.id).emit('battle-update', {
      player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
      player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: attackType,
      statusEffect,
      target: isPlayer1 ? 'opponent' : 'player',
      timingWindow: battle.timingWindow,
    });
    io.to(battle.player2.id).emit('battle-update', {
      player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
      player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
      log: battle.log,
      cooldowns: battle.cooldowns,
      attackEffect: attackType,
      statusEffect,
      target: isPlayer1 ? 'opponent' : 'player',
      timingWindow: battle.timingWindow,
    });
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const playerIndex = waitingPlayers.findIndex((p) => p.id === socket.id);
    if (playerIndex !== -1) {
      waitingPlayers.splice(playerIndex, 1);
      console.log('Removed player from waiting list:', { socketId: socket.id, waitingPlayers: waitingPlayers.length });
    }

    // End any active battles involving this player
    for (const roomId in battles) {
      const battle = battles[roomId];
      if (battle.player1.id === socket.id || battle.player2.id === socket.id) {
        const remainingPlayerId = battle.player1.id === socket.id ? battle.player2.id : battle.player1.id;
        io.to(remainingPlayerId).emit('battle-end', {
          result: `Opponent disconnected! ${battle.player1.id === socket.id ? 'Player 2' : 'Player 1'} wins by default!`,
          player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
          player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
          log: [...battle.log, { message: 'Opponent disconnected!', timestamp: Date.now() }],
        });
        console.log('Battle ended due to disconnect:', { roomId, winner: remainingPlayerId });
        delete battles[roomId];
      }
    }
  });
});

// Inactivity timeout for battles
setInterval(() => {
  Object.keys(battles).forEach((roomId) => {
    const battle = battles[roomId];
    if (Date.now() - battle.lastAction > 30000) {
      battle.log.push({ message: 'Battle ended due to inactivity!', timestamp: Date.now() });
      let result = 'Draw! Battle timed out due to inactivity.';
      io.to(battle.player1.id).emit('battle-end', {
        result,
        player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
        player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
        log: battle.log,
      });
      io.to(battle.player2.id).emit('battle-end', {
        result,
        player1: { id: battle.player1.id, goblinAsset: battle.player1.goblinAsset, hp: battle.player1.hp, status: battle.player1.status },
        player2: { id: battle.player2.id, goblinAsset: battle.player2.goblinAsset, hp: battle.player2.hp, status: battle.player2.status },
        log: battle.log,
      });
      console.log('Battle ended due to inactivity:', { roomId });
      delete battles[roomId];
    }
  });
}, 1000);

server.listen(4000, () => {
  console.log('Socket.IO server running on port 4000');
});