// server.js

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const fs        = require("fs");
const path      = require("path");
const cors      = require("cors");       // <-- ADD THIS LINE

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── ENABLE CORS FOR ALL ORIGINS ──────────────────────────────────────
// Allow cross‐origin requests (e.g. Netlify front end → Render backend)
app.use(cors());

app.use(express.static("public"));

const GRID_WIDTH  = 20;
const GRID_HEIGHT = 20;
const HIGHSCORES_FILE = path.join(__dirname, "highscores.json");

let queue         = [];     // spectators waiting to become player
let currentPlayer = null;   // WS of the player
let blocks        = [];     // spectator‐placed blocks

// Load highScores from disk (or start empty)
let highScores = [];
try {
  const data = fs.readFileSync(HIGHSCORES_FILE, "utf8");
  highScores = JSON.parse(data);
} catch (e) {
  highScores = [];
}

// Persist highScores array (up to top 10) back to disk
function saveHighScores() {
  // Only keep top 10
  highScores = highScores
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  fs.writeFileSync(HIGHSCORES_FILE, JSON.stringify(highScores, null, 2), "utf8");
}

// Returns a fresh snake + direction (food will be spawned separately)
function createInitialGameState() {
  return {
    snake: [{ x: 10, y: 10 }],
    direction: { x: 1, y: 0 },
    food: null
  };
}

let gameState = createInitialGameState();
spawnFood();  // place first pellet

// Place food in a random empty cell
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

// If there is no currentPlayer, pull from queue
function assignRoles() {
  if (!currentPlayer && queue.length > 0) {
    currentPlayer = queue.shift();
    currentPlayer.role = "player";
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }
}

// Handle a “death” (hitting wall, block, or self)
function handleDeath() {
  if (currentPlayer) {
    currentPlayer.send(JSON.stringify({ type: "gameOver" }));

    // If someone is waiting, demote this player → spectator and re‐queue
    if (queue.length > 0) {
      currentPlayer.role = "spectator";
      queue.push(currentPlayer);
      currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      currentPlayer = null;
      assignRoles();
    } else {
      // No one waiting: keep the same player, but we’ll re‐notify below
    }
  }

  // Reset board
  blocks = [];
  gameState = createInitialGameState();
  spawnFood();

  // If same player remains (queue was empty), re‐notify them of their role
  if (currentPlayer) {
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }

  // Broadcast fresh state so clients see the new snake immediately
  broadcastGameState();
}

// Move the snake, handle growth on food, and collisions (including walls)
function moveSnake() {
  const head = gameState.snake[0];
  const dir  = gameState.direction;
  const newHead = { x: head.x + dir.x, y: head.y + dir.y };

  // ── WALL COLLISION: if new head is outside the grid, trigger death
  if (
    newHead.x < 0 || newHead.x >= GRID_WIDTH ||
    newHead.y < 0 || newHead.y >= GRID_HEIGHT
  ) {
    handleDeath();
    return;
  }

  // Check collisions with blocks or itself
  const hitBlock = blocks.some(b => b.x === newHead.x && b.y === newHead.y);
  const hitSelf  = gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y);
  if (hitBlock || hitSelf) {
    handleDeath();
    return;
  }

  // Normal movement: push new head
  gameState.snake.unshift(newHead);

  // Eating food?
  if (newHead.x === gameState.food.x && newHead.y === gameState.food.y) {
    // Increase currentPlayer’s score
    if (currentPlayer) {
      currentPlayer.score = (currentPlayer.score || 0) + 1;

      // Update highScores for this player
      const idx = highScores.findIndex(h => h.name === currentPlayer.name);
      if (idx >= 0) {
        if (currentPlayer.score > highScores[idx].score) {
          highScores[idx].score = currentPlayer.score;
        }
      } else {
        highScores.push({ name: currentPlayer.name, score: currentPlayer.score });
      }
      saveHighScores();
    }

    // Don’t pop tail → snake grows
    spawnFood();
  } else {
    // Normal move: pop tail
    gameState.snake.pop();
  }
}

// Broadcast the entire game state (snake/blocks/food/players/highScores)
function broadcastGameState() {
  // Build a simple array of {name, role} for every connected socket
  const playersList = [];
  wss.clients.forEach(ws => {
    if (ws.name) {
      playersList.push({ name: ws.name, role: ws.role });
    }
  });

  const payload = JSON.stringify({
    type: "updateGameState",
    state: {
      snake: gameState.snake,
      blocks,
      food: gameState.food,
      players: playersList,
      highScores
    }
  });

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  });
}

// Game loop: every 200ms, move+broadcast if there’s a player
setInterval(() => {
  if (currentPlayer) {
    moveSnake();
    broadcastGameState();
  }
}, 200);

// Handle incoming WebSocket connections
wss.on("connection", ws => {
  ws.score = 0; // track this session’s score

  ws.on("message", raw => {
    const data = JSON.parse(raw);

    // When a client first joins
    if (data.type === "join") {
      ws.name          = data.name;
      ws.lastBlockTime = 0;

      if (!currentPlayer) {
        // No player yet → make this socket the player
        currentPlayer = ws;
        ws.role        = "player";
        ws.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      } else {
        // Already have a player → this one becomes spectator
        ws.role    = "spectator";
        queue.push(ws);
        ws.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      }

      // Immediately broadcast so they see the board & scores as soon as they join
      broadcastGameState();
    }

    // Spectator places a block
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

    // Client clicked “Refresh Game”
    if (data.type === "reset") {
      // If someone is waiting, demote current player → spectator and assign next
      if (currentPlayer && queue.length > 0) {
        currentPlayer.role = "spectator";
        queue.push(currentPlayer);
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
        currentPlayer = null;
        assignRoles();
      } else if (currentPlayer) {
        // No one waiting: re‐notify the same player of their role
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      }

      // Reset board: clear blocks, new snake, new food
      blocks = [];
      gameState = createInitialGameState();
      spawnFood();

      // Broadcast the fresh state immediately
      broadcastGameState();
    }
  });

  ws.on("close", () => {
    // If the player disconnects, pick the next spectator
    if (ws === currentPlayer) {
      currentPlayer = null;
      assignRoles();
    } else {
      // Otherwise remove from queue
      queue = queue.filter(s => s !== ws);
    }
    // Update everyone’s player list & highScores
    broadcastGameState();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
