const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static("public"));

let queue         = [];
let spectators    = [];
let currentPlayer = null;
let blocks        = [];

// Generate a fresh snake & direction
function createInitialGameState() {
  return {
    snake: [{ x: 10, y: 10 }],
    direction: { x: 1, y: 0 }
  };
}

let gameState = createInitialGameState();

// Assign next spectator to be player
function assignRoles() {
  if (!currentPlayer && queue.length > 0) {
    currentPlayer = queue.shift();
    currentPlayer.role = "player";
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }
}

// Advance the snake, handle death & reset
function moveSnake() {
  const head = gameState.snake[0];
  const dir  = gameState.direction;
  const newHead = { x: head.x + dir.x, y: head.y + dir.y };

  // Collision with a block or itself?
  if (
    blocks.some(b => b.x === newHead.x && b.y === newHead.y) ||
    gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y)
  ) {
    // Notify the player
    if (currentPlayer) {
      currentPlayer.send(JSON.stringify({ type: "gameOver" }));
    }

    // Reset everything
    currentPlayer = null;
    blocks        = [];                   // ← clear old blocks
    gameState     = createInitialGameState();  // ← fresh snake+direction

    // Immediately push this reset state to all clients
    broadcastGameState();

    // And pick the next player
    assignRoles();
    return;
  }

  // Normal move: grow at head, shrink at tail
  gameState.snake.unshift(newHead);
  gameState.snake.pop();
}

// Send the full state to every connected client
function broadcastGameState() {
  const state = {
    snake: gameState.snake,
    blocks,
    // you can add food here if you re-introduce it
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "updateGameState", state }));
    }
  });
}

// Run the game loop
setInterval(() => {
  if (currentPlayer) {
    moveSnake();
    broadcastGameState();
  }
}, 200);

// WebSocket connection handling
wss.on("connection", ws => {
  ws.on("message", msg => {
    const data = JSON.parse(msg);

    if (data.type === "join") {
      ws.name          = data.name;
      ws.lastBlockTime = 0;

      if (!currentPlayer) {
        currentPlayer = ws;
        ws.role        = "player";
        ws.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      } else {
        ws.role       = "spectator";
        spectators.push(ws);
        queue.push(ws);
        ws.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      }
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
      queue      = queue.filter(q => q !== ws);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
