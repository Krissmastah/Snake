// server.js

const express    = require("express");
const http       = require("http");
const WebSocket  = require("ws");
const fs         = require("fs");
const path       = require("path");
const cors       = require("cors");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const { createClient } = require("@libsql/client");

//////////////////////////////////////
// 1) Configure Turso (LibSQL) client
//////////////////////////////////////

// Use your Turso connection string (HTTPS form) in Render’s Environment as TURSO_URL.
// If your Turso DB requires a service token, put it in TURSO_AUTH.
const libsql = createClient({
  url: process.env.TURSO_URL || "https://snakesnape-krissmastah.aws-eu-west-1.turso.io",
  auth: {
    token: process.env.TURSO_AUTH || ""
  }
});

////////////////////////////////////////////////
// 2) Configure JWT secret for session tokens
////////////////////////////////////////////////

// Store a long, random JWT_SECRET in Render’s environment variable.
const JWT_SECRET = process.env.JWT_SECRET || "replace_this_with_a_strong_random_string";

////////////////////////////////////////////////
// 3) Express + HTTP + WebSocket setup
////////////////////////////////////////////////

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// ── CORS Setup ──────────────────────────────────────────────────────────
// Only allow requests from your Netlify front-end
const allowedOrigin = "https://snakesnape.netlify.app";

app.use(cors({
  origin: allowedOrigin,
  methods: ["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

// Make sure preflight (OPTIONS) is handled for every route:
app.options("*", cors({
  origin: allowedOrigin,
  methods: ["GET","HEAD","PUT","PATCH","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

// Parse JSON bodies
app.use(express.json());

// (Optional) If you ever want to serve static files from "public", keep this.
// In most cases, your front-end is on Netlify, so this is unused.
app.use(express.static("public"));

////////////////////////////////////////
// 4) Persistent high-scores on disk
////////////////////////////////////////

const HIGHSCORES_FILE = path.join(__dirname, "highscores.json");

// Auto-create if missing
if (!fs.existsSync(HIGHSCORES_FILE)) {
  fs.writeFileSync(HIGHSCORES_FILE, "[]", "utf8");
}

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

////////////////////////////////////////////
// 5) Authentication Endpoints (Turso-backed)
////////////////////////////////////////////

// POST /register → create a new user in Turso
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  try {
    // Check if username already exists
    const existing = await libsql.execute({
      sql: "SELECT 1 FROM users WHERE username = ?",
      args: [username]
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Username already taken." });
    }

    // Hash the password
    const password_hash = await bcrypt.hash(password, 10);
    // Insert into Turso
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

// POST /login → verify credentials & return JWT
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  try {
    // Fetch user record
    const result = await libsql.execute({
      sql: "SELECT password_hash FROM users WHERE username = ?",
      args: [username]
    });
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const password_hash = result.rows[0].password_hash;
    const match = await bcrypt.compare(password, password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // Issue a JWT (expires in 2 hours)
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "2h" });
    return res.json({ token });
  } catch (e) {
    console.error("Login error:", e);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/////////////////////////////////////////////////////////////
// 6) In-memory game state & helper functions (same as before)
/////////////////////////////////////////////////////////////

const GRID_WIDTH  = 20;
const GRID_HEIGHT = 20;

let queue         = [];     // Spectators waiting to become player
let currentPlayer = null;   // WS of the current player
let blocks        = [];     // Spectator-placed blocks

// Helper: fresh snake + direction (food null for now)
function createInitialGameState() {
  return {
    snake: [{ x: 10, y: 10 }],
    direction: { x: 1, y: 0 },
    food: null
  };
}

let gameState = createInitialGameState();
spawnFood();

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

function assignRoles() {
  if (!currentPlayer && queue.length > 0) {
    currentPlayer = queue.shift();
    currentPlayer.role = "player";
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }
}

function handleDeath() {
  if (currentPlayer) {
    currentPlayer.send(JSON.stringify({ type: "gameOver" }));

    // If there is a spectator waiting, demote current player → spectator
    if (queue.length > 0) {
      currentPlayer.role = "spectator";
      queue.push(currentPlayer);
      currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
      currentPlayer = null;
      assignRoles();
    }
    // If no one waiting, same player remains—but we re-notify below
  }

  // Reset board
  blocks = [];
  gameState = createInitialGameState();
  spawnFood();

  // If same player remains, re-notify them
  if (currentPlayer) {
    currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "player" }));
  }

  broadcastGameState();
}

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

  // BLOCK or SELF collision?
  const hitBlock = blocks.some(b => b.x === newHead.x && b.y === newHead.y);
  const hitSelf  = gameState.snake.some(p => p.x === newHead.x && p.y === newHead.y);
  if (hitBlock || hitSelf) {
    handleDeath();
    return;
  }

  // Advance snake
  gameState.snake.unshift(newHead);

  // Eating food?
  if (newHead.x === gameState.food.x && newHead.y === gameState.food.y) {
    // Increase score
    if (currentPlayer) {
      currentPlayer.sessionScore = (currentPlayer.sessionScore || 0) + 1;
      // Update highScores
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
    // Don’t pop tail → snake grows
    spawnFood();
  } else {
    // Normal move
    gameState.snake.pop();
  }
}

function broadcastGameState() {
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

// Game loop: tick every 200ms if there’s a player
setInterval(() => {
  if (currentPlayer) {
    moveSnake();
    broadcastGameState();
  }
}, 200);

///////////////////////////////////////////////////////
// 7) Handle WebSocket “upgrade” – validate JWT or guest
///////////////////////////////////////////////////////

server.on("upgrade", (req, socket, head) => {
  // Parse URL query params
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const token = urlObj.searchParams.get("token");
  const guest = urlObj.searchParams.get("guest");

  if (token) {
    // If token present → verify it
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      req.username = decoded.username;
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit("connection", ws, req);
      });
    });
  } else if (guest === "true") {
    // Guest mode: assign a random Guest name
    const randNum = Math.floor(1000 + Math.random() * 9000);
    req.username = `Guest${randNum}`;
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } else {
    // No token & no guest flag → reject
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

///////////////////////////////////////////////////////////
// 8) Handle new WebSocket connections (authenticated or guest)
///////////////////////////////////////////////////////////

wss.on("connection", (ws, request) => {
  ws.username     = request.username; // from upgrade step
  ws.sessionScore = 0;                // track this user’s session score
  ws.lastBlockTime = 0;               // for spectator block cooldown
  ws.role         = null;

  ws.on("message", raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // JOIN message: assign roles & let them start playing
    if (data.type === "join") {
      // We ignore data.name for authenticated users—use ws.username
      // For guests, ws.username is already “Guest####.”
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

    // Spectator places a block (with 60s cooldown)
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

    // Refresh game
    if (data.type === "reset") {
      if (currentPlayer && queue.length > 0) {
        currentPlayer.role = "spectator";
        queue.push(currentPlayer);
        currentPlayer.send(JSON.stringify({ type: "roleAssignment", role: "spectator" }));
        currentPlayer = null;
        assignRoles();
      } else if (currentPlayer) {
        // No one waiting
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

///////////////////////////////////
// 9) Start the HTTP + WS server
///////////////////////////////////

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
