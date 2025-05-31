// server.js

const express       = require("express");
const http          = require("http");
const WebSocket     = require("ws");
const fs            = require("fs");
const path          = require("path");
const bcrypt        = require("bcrypt");
const jwt           = require("jsonwebtoken");
const bodyParser    = require("body-parser");
const { createClient } = require("@libsql/client");

require("dotenv").config(); // for JWT_SECRET, TURSO_URL

// ── Configure Turso (LibSQL) client ──────────────────────────────────────
const libsql = createClient({
  url: process.env.TURSO_URL || "libsql://snakesnape-krissmastah.aws-eu-west-1.turso.io",
  auth: {
    // If you set a secret or token for Turso, set it in env TURSO_AUTH.
    token: process.env.TURSO_AUTH || ""
  }
});

// ── JWT setup ────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "replace_this_with_a_strong_secret";

// ── Express + HTTP + WebSocket setup ────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// Serve static files from public/
app.use(express.static("public"));
app.use(bodyParser.json()); // to parse JSON bodies

// ── High‐score file on disk ───────────────────────────────────────────────
const HIGHSCORES_FILE = path.join(__dirname, "highscores.json");
let highScores = [];
try {
  highScores = JSON.parse(fs.readFileSync(HIGHSCORES_FILE, "utf8"));
} catch {
  highScores = [];
}
function saveHighScores() {
  highScores = highScores.sort((a, b) => b.score - a.score).slice(0, 10);
  fs.writeFileSync(HIGHSCORES_FILE, JSON.stringify(highScores, null, 2), "utf8");
}

// ── In‐memory game state ─────────────────────────────────────────────────
const GRID_WIDTH  = 20;
const GRID_HEIGHT = 20;

let queue         = [];     // spectators waiting to become player
let currentPlayer = null;   // WS of the current player
let blocks        = [];     // spectator‐placed blocks
let gameState     = createInitialGameState();
spawnFood();

// ── Helper: create a fresh snake + direction, food null for now ─────────
function createInitialGameState() {
  return {
    snake: [{ x: 10, y: 10 }],
    direction: { x: 1, y: 0 },
    food: null
  };
}

// ── Spawn food pellet in random empty cell ───────────────────────────────
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

// ── Assign next waiting WS as player ────────────────────────────────────
function assignRoles() {
  if (!currentPlayer && queue.length > 0) {
    currentPlayer = queue.shift();
    currentPlayer.role = "player";
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }
}

// ── Move snake (including wall collisions & growth) ─────────────────────
function moveSnake() {
  const head = gameState.snake[0];
  const dir  = gameState.direction;
  const newHead = { x: head.x + dir.x, y: head.y + dir.y };

  // WALL COLLISION
  if (
    newHead.x < 0 || newHead.x >= GRID_WIDTH ||
    newHead.y < 0 || newHead.y >= GRID_HEIGHT
  ) {
    handleDeath();
    return;
  }

  // BLOCK OR SELF COLLISION?
  const hitBlock = blocks.some(b => b.x === newHead.x && b.y === newHead.y);
  const hitSelf  = gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y);
  if (hitBlock || hitSelf) {
    handleDeath();
    return;
  }

  // NORMAL ADVANCE
  gameState.snake.unshift(newHead);

  // EATING FOOD?
  if (newHead.x === gameState.food.x && newHead.y === gameState.food.y) {
    // Increase player's session score
    if (currentPlayer) {
      currentPlayer.sessionScore = (currentPlayer.sessionScore || 0) + 1;

      // Update highScores in memory
      const idx = highScores.findIndex(h => h.name === currentPlayer.username);
      if (idx >= 0) {
        if (currentPlayer.sessionScore > highScores[idx].score) {
          highScores[idx].score = currentPlayer.sessionScore;
        }
      } else {
        highScores.push({
          name: currentPlayer.username,
          score: currentPlayer.sessionScore
        });
      }
      saveHighScores();
    }
    // Don't pop tail → snake grows
    spawnFood();
  } else {
    gameState.snake.pop();
  }
}

// ── Handle a “death” (snake hitting wall, block, or itself) ─────────────
function handleDeath() {
  if (currentPlayer) {
    currentPlayer.send(JSON.stringify({ type: "gameOver" }));
    // If there is anyone waiting, demote this player → spectator and enqueue
    if (queue.length > 0) {
      currentPlayer.role = "spectator";
      queue.push(currentPlayer);
      currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      currentPlayer = null;
      assignRoles();
    } else {
      // No one waiting → same player remains, re-notify below
    }
  }

  // Reset the board entirely
  blocks = [];
  gameState = createInitialGameState();
  spawnFood();

  // If same player remains, re-notify them of their role
  if (currentPlayer) {
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }

  // Broadcast fresh state so clients see the new board immediately
  broadcastGameState();
}

// ── Broadcast entire game state (snake/blocks/food/players/highScores) ──
function broadcastGameState() {
  // Build players list from all connected sockets
  const playersList = [];
  wss.clients.forEach(ws => {
    if (ws.username) {
      playersList.push({ name: ws.username, role: ws.role });
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

// ── Game loop: every 200ms, move & broadcast if there’s a player ───────
setInterval(() => {
  if (currentPlayer) {
    moveSnake();
    broadcastGameState();
  }
}, 200);

// ── EXPRESS ROUTES: Register & Login ──────────────────────────────────

// Helper: Hash password
async function hashPassword(password) {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
}

// Helper: Verify password
async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// POST /register { username, password } → create user
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  // Check if username exists
  try {
    const existing = await libsql.execute({
      sql: "SELECT 1 FROM users WHERE username = ?",
      args: [username]
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Username already taken." });
    }

    // Hash password and insert
    const password_hash = await hashPassword(password);
    await libsql.execute({
      sql: "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      args: [username, password_hash]
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("Register error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// POST /login { username, password } → issue JWT
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  try {
    // Fetch user
    const result = await libsql.execute({
      sql: "SELECT password_hash FROM users WHERE username = ?",
      args: [username]
    });
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const password_hash = result.rows[0].password_hash;
    const match = await verifyPassword(password, password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Credentials valid → issue JWT (expires in 1h)
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "1h" });
    return res.json({ token });
  } catch (e) {
    console.error("Login error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

// ── HTTP “upgrade” to WebSocket, verifying JWT in query string ──────────
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get("token");
  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Verify JWT
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Attach username to the request for use once connected
    request.username = decoded.username;
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit("connection", ws, request);
    });
  });
});

// ── Handle new WebSocket connections ────────────────────────────────────
wss.on("connection", (ws, request) => {
  // The username from the JWT
  ws.username = request.username;
  ws.role     = null;      // will be set after “join”
  ws.sessionScore = 0;     // track score this session

  // Listen for messages
  ws.on("message", raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // JOIN message is sent from client once the WS is open
    if (data.type === "join") {
      // data.name is ignored, we trust ws.username from JWT
      if (!currentPlayer) {
        currentPlayer = ws;
        ws.role        = "player";
        ws.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      } else {
        ws.role    = "spectator";
        queue.push(ws);
        ws.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      }
      broadcastGameState();
    }

    // PLACE BLOCK (spectator only, cooldown enforced)
    if (data.type === "placeBlock" && ws.role === "spectator") {
      const now = Date.now();
      if (!ws.lastBlockTime || now - ws.lastBlockTime >= 60000) {
        blocks.push({ x: data.x, y: data.y });
        ws.lastBlockTime = now;
      }
    }

    // CHANGE DIRECTION (player only)
    if (data.type === "changeDirection" && ws.role === "player") {
      gameState.direction = data.direction;
    }

    // REFRESH GAME
    if (data.type === "reset") {
      if (currentPlayer && queue.length > 0) {
        currentPlayer.role = "spectator";
        queue.push(currentPlayer);
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
        currentPlayer = null;
        assignRoles();
      } else if (currentPlayer) {
        // No one waiting, re-notify same player
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
      }
      blocks = [];
      gameState = createInitialGameState();
      spawnFood();
      broadcastGameState();
    }
  });

  ws.on("close", () => {
    if (ws === currentPlayer) {
      currentPlayer = null;
      assignRoles();
    } else {
      queue = queue.filter(s => s !== ws);
    }
    broadcastGameState();
  });
});

// Start HTTP + WS server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
