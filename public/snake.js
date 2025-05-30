const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3000;
const WIDTH = 20;
const HEIGHT = 20;
const TICK_RATE = 100; // ms

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

let clients = new Map(); // ws -> { name, role }
let gameState = {
  // start snake in center moving right:
  snake: [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }],
  direction: { x: 1, y: 0 },
  blocks: [],
  food: null
};

// spawn first food
spawnFood();

// Assign roles round-robin: first two joiners are players, rest are spectators
function assignRoles() {
  const joiners = Array.from(clients.values());
  clients.forEach((info, ws) => {
    let idx = joiners.indexOf(info);
    info.role = idx < 2 ? 'player' : 'spectator';
    ws.send(JSON.stringify({ type: 'roleAssignment', role: info.role }));
  });
}

// clean up and reassign when someone leaves
function broadcastRoleAssignments() {
  assignRoles();
}

// spawn food at random empty cell
function spawnFood() {
  let x, y;
  do {
    x = Math.floor(Math.random() * WIDTH);
    y = Math.floor(Math.random() * HEIGHT);
  } while (
    gameState.snake.some(p => p.x === x && p.y === y) ||
    gameState.blocks.some(b => b.x === x && b.y === y)
  );
  gameState.food = { x, y };
}

// on new WS connection
wss.on('connection', ws => {
  clients.set(ws, { name: null, role: 'spectator' });

  ws.on('message', msg => {
    const data = JSON.parse(msg);
    if (data.type === 'join') {
      clients.get(ws).name = data.name;
      broadcastRoleAssignments();
    }
    if (data.type === 'changeDirection' && clients.get(ws).role === 'player') {
      // Only allow one player to set direction (the first player)
      gameState.direction = data.direction;
    }
    if (data.type === 'placeBlock' && clients.get(ws).role === 'spectator') {
      gameState.blocks.push({ x: data.x, y: data.y });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastRoleAssignments();
  });
});

// game loop
setInterval(() => {
  // advance snake head
  const head = gameState.snake[0];
  const newHead = {
    x: (head.x + gameState.direction.x + WIDTH) % WIDTH,
    y: (head.y + gameState.direction.y + HEIGHT) % HEIGHT
  };

  // check collision with blocks or self
  if (
    gameState.blocks.some(b => b.x === newHead.x && b.y === newHead.y) ||
    gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y)
  ) {
    // reset game
    gameState.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    gameState.direction = { x: 1, y: 0 };
    gameState.blocks = [];
    spawnFood();
    // notify clients
    wss.clients.forEach(c =>
      c.send(JSON.stringify({ type: 'gameOver' }))
    );
    return;
  }

  gameState.snake.unshift(newHead);

  // eating food?
  if (newHead.x === gameState.food.x && newHead.y === gameState.food.y) {
    spawnFood();
  } else {
    // normal move
    gameState.snake.pop();
  }

  // broadcast full state
  const payload = JSON.stringify({
    type: 'updateGameState',
    state: {
      snakes: [gameState.snake],     // array of snakes (here single)
      blocks: gameState.blocks,
      food: gameState.food
    }
  });
  wss.clients.forEach(c => {
    if (c.readyState === c.OPEN) c.send(payload);
  });
}, TICK_RATE);
