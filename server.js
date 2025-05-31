// server.js

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static("public"));

const GRID_WIDTH  = 20;
const GRID_HEIGHT = 20;

let queue         = [];     // spectators waiting to become player
let spectators    = [];     // list of all spectator WebSockets
let currentPlayer = null;   // the WebSocket of whoever is currently playing
let blocks        = [];     // array of {x,y} for spectator‐placed blocks

// Creates a fresh snake (centered) + direction; food is set to null for now
function createInitialGameState() {
  return {
    snake: [{ x: 10, y: 10 }],
    direction: { x: 1, y: 0 },
    food: null
  };
}

let gameState = createInitialGameState();
spawnFood(); // place the first food pellet

// Pick a random empty cell for food
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

// If no currentPlayer, assign the next WebSocket in queue to be player
function assignRoles() {
  if (!currentPlayer && queue.length > 0) {
    currentPlayer = queue.shift();
    currentPlayer.role = "player";
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }
}

// Advance snake; grow on eating; if collision → handle death/rotate roles
function moveSnake() {
  const head = gameState.snake[0];
  const dir  = gameState.direction;
  const newHead = {
    x: head.x + dir.x,
    y: head.y + dir.y
  };

  // Collision with block or self?
  if (
    blocks.some(b => b.x === newHead.x && b.y === newHead.y) ||
    gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y)
  ) {
    // 1) Notify old player they lost
    if (currentPlayer) {
      currentPlayer.send(JSON.stringify({ type: "gameOver" }));
      // If there's someone waiting, demote them to spectator and re-queue
      if (queue.length > 0) {
        currentPlayer.role = "spectator";
        queue.push(currentPlayer);
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
        currentPlayer = null;
        assignRoles();
      }
      // If no one is waiting, we keep the same player but we still reset the board below
    }

    // 2) Reset game state & blocks
    blocks = [];
    gameState = createInitialGameState();
    spawnFood();

    // 3) Immediately broadcast the fresh board (new snake + empty blocks + fresh food)
    broadcastGameState();
    return;
  }

  // No collision: move normally
  gameState.snake.unshift(newHead);

  // Eating food?
  if (newHead.x === gameState.food.x && newHead.y === gameState.food.y) {
    // Don’t pop tail → snake grows
    spawnFood();
  } else {
    gameState.snake.pop();
  }
}

// Broadcast { type: "updateGameState", state } to all connected clients
// We now include `players: [...]` so clients can render an overview
function broadcastGameState() {
  // Build an array of all connected players (WebSocket → {name, role})
  const players = [];
  wss.clients.forEach(ws => {
    if (ws.name) {
      players.push({
        name: ws.name,
        role: ws.role || "spectator"
      });
    }
  });

  const statePayload = {
    snake: gameState.snake,
    blocks,
    food: gameState.food,
    players
  };

  const msg = JSON.stringify({ type: "updateGameState", state: statePayload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Game loop → every 200ms, if there’s a player, move + broadcast
setInterval(() => {
  if (currentPlayer) {
    moveSnake();
    broadcastGameState();
  }
}, 200);

// Handle new WebSocket connections
wss.on("connection", ws => {
  // Give each new socket a default score of 0
  ws.score = 0;

  ws.on("message", raw => {
    const data = JSON.parse(raw);

    // When someone clicks "Join" / on page load, they’ll send this
    if (data.type === "join") {
      ws.name          = data.name;
      ws.lastBlockTime = 0;

      if (!currentPlayer) {
        // If no one is playing, make this socket the player
        currentPlayer = ws;
        ws.role        = "player";
        ws.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      } else {
        // Otherwise, make them a spectator and add to the queue
        ws.role       = "spectator";
        queue.push(ws);
        ws.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      }

      // Immediately send the current game state so they see the board right away
      broadcastGameState();
    }

    // Spectator wants to place a block
    if (data.type === "placeBlock" && ws.role === "spectator") {
      const now = Date.now();
      if (now - ws.lastBlockTime >= 60000) {
        blocks.push({ x: data.x, y: data.y });
        ws.lastBlockTime = now;
      }
    }

    // Player changes direction
    if (data.type === "changeDirection" && ws.role === "player") {
      gameState.direction = data.direction;
    }

    // NEW: Someone clicked “Refresh Game”
    if (data.type === "reset") {
      // If there is someone waiting, demote the current player
      if (currentPlayer && queue.length > 0) {
        currentPlayer.role = "spectator";
        queue.push(currentPlayer);
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
        currentPlayer = null;
        assignRoles();
      }
      // Otherwise, if no one is waiting, keep the same currentPlayer

      // Clear blocks + reset snake + spawn new food
      blocks = [];
      gameState = createInitialGameState();
      spawnFood();
      // Immediately broadcast fresh board
      broadcastGameState();
    }
  });

  ws.on("close", () => {
    // If the current player disconnected, pick the next spectator
    if (ws === currentPlayer) {
      currentPlayer = null;
      assignRoles();
    } else {
      // Otherwise remove them from the queue
      spectators = spectators.filter(s => s !== ws);
      queue      = queue.filter(q => q !== ws);
    }
    // Update everyone’s “players” list
    broadcastGameState();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
