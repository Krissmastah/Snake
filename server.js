const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const GRID_WIDTH = 20;
const GRID_HEIGHT = 20;

let queue = [];
let spectators = [];
let currentPlayer = null;
let blocks = [];

// Create initial game state (snake + direction), then spawn the first food
function createInitialGameState() {
  return {
    snake: [{ x: 10, y: 10 }],
    direction: { x: 1, y: 0 },
    food: null
  };
}

let gameState = createInitialGameState();
spawnFood();

// Spawn a food pellet at a random empty cell
function spawnFood() {
  let x, y;
  do {
    x = Math.floor(Math.random() * GRID_WIDTH);
    y = Math.floor(Math.random() * GRID_HEIGHT);
  } while (
    gameState.snake.some(p => p.x === x && p.y === y) ||
    blocks.some(b => b.x === x && b.y === y)
  );
  gameState.food = { x, y };
}

// Assign the next spectator in queue to be the player
function assignRoles() {
  if (!currentPlayer && queue.length > 0) {
    currentPlayer = queue.shift();
    currentPlayer.role = "player";
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }
}

// Move the snake, grow on eating, reset on collision
function moveSnake() {
  const head = gameState.snake[0];
  const dir = gameState.direction;
  const newHead = { x: head.x + dir.x, y: head.y + dir.y };

  // Check collision with blocks or self
  if (
    blocks.some(b => b.x === newHead.x && b.y === newHead.y) ||
    gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y)
  ) {
    // Game over: reset state and roles
    if (currentPlayer) currentPlayer.send(JSON.stringify({ type: "gameOver" }));
    currentPlayer = null;
    blocks = [];
    gameState = createInitialGameState();
    spawnFood();
    assignRoles();
    return;
  }

  // Advance snake
  gameState.snake.unshift(newHead);

  // Eating food?
  if (newHead.x === gameState.food.x && newHead.y === gameState.food.y) {
    // Grow (don't pop tail) and spawn a new pellet
    spawnFood();
  } else {
    // Normal move
    gameState.snake.pop();
  }
}

// Broadcast the full game state (snake, blocks, food) to everyone
function broadcastGameState() {
  const state = {
    snake: gameState.snake,
    blocks,
    food: gameState.food
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "updateGameState", state }));
    }
  });
}

// Game loop: tick every 200ms
setInterval(() => {
  if (currentPlayer) {
    moveSnake();
    broadcastGameState();
  }
}, 200);

// Handle new WebSocket connections
wss.on("connection", ws => {
  ws.on("message", msg => {
    const data = JSON.parse(msg);

    if (data.type === "join") {
      ws.name = data.name;
      ws.lastBlockTime = 0;

      if (!currentPlayer) {
        // First joiner becomes player
        currentPlayer = ws;
        ws.role = "player";
        ws.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      } else {
        // Others are spectators
        ws.role = "spectator";
        spectators.push(ws);
        queue.push(ws);
        ws.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      }

      // ← NEW: Immediately send the current state so the snake appears right away
      broadcastGameState();
    }

    if (data.type === "placeBlock" && ws.role === "spectator") {
      const now = Date.now();
      if (now - ws.lastBlockTime >= 60000) {
        blocks.push({ x: data.x, y: data.y });
        ws.lastBlockTime = now;
      }
    }

    if (data.type === "changeDirection" && ws.role === "player") {
      gameState.direction = data.direction;
    }
  });

  ws.on("close", () => {
    if (ws === currentPlayer) {
      currentPlayer = null;
      assignRoles();
    } else {
      spectators = spectators.filter(s => s !== ws);
      queue = queue.filter(q => q !== ws);
    }
  });
});

server.listen(process.env.PORT || 8080, () => {
  console.log("Server started on port", process.env.PORT || 8080);
});
