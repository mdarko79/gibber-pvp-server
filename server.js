const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

// Socket.IO z CORS (pozwala na połączenia z Twojej domeny + localhost)
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'https://www.goblingibber.com',
      'https://goblingibber.com',
    ],
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
  const player1StatusEffect = applyStatusEffects(battle, battle.player1, 'Player 1', 'Player 2');
  const player2StatusEffect = applyStatusEffects(battle, battle.player2, 'Player 2', 'Player 1');

  // Update timing window
  battle.timingWindow = Math.random() < 0.2;

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

    delete battles[roomId];
  }
}

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

      io.to(player1.id).emit('battle-start', { roomId, ...battles[roomId] });
      io.to(player2.id).emit('battle-start', { roomId, ...battles[roomId] });
    } else {
      socket.emit('waiting', { message: 'Waiting for an opponent...' });
    }
  });

  socket.on('disconnect', () => {
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
    if (Date.now() - battle.lastAction > 30000) {
      const result = 'Draw! Battle timed out due to inactivity.';
      io.to(battle.player1.id).emit('battle-end', { result, ...battle });
      io.to(battle.player2.id).emit('battle-end', { result, ...battle });
      delete battles[roomId];
    }
  });
}, 1000);

// ✅ WAŻNE: używamy process.env.PORT (dla Render)
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
