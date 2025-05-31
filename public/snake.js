// public/snake.js

// 1) Grab DOM elements
const canvas       = document.getElementById("gameCanvas");
const ctx          = canvas.getContext("2d");
const playersList  = document.getElementById("playersList");
const highscoreList = document.getElementById("highscoreList");
const roleP        = document.getElementById("role");
const abilityBtn   = document.getElementById("useAbility");
const refreshBtn   = document.getElementById("refreshBtn");

// 2) Ask for player name & initialize role
let playerName = prompt("Enter your name:") || "Anon";
let role       = "spectator";

// 3) Connect to Render backend via WebSocket
const BACKEND_URL = window.BACKEND_URL;
const socket      = new WebSocket(BACKEND_URL.replace(/^http/, "ws"));

// 4) When socket opens, send join message
socket.onopen = () => {
  socket.send(JSON.stringify({ type: "join", name: playerName }));
};

// 5) Handle errors
socket.onerror = err => console.error("WS error", err);

// 6) Handle incoming messages
socket.onmessage = ev => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "roleAssignment") {
    // The server tells us: "player" or "spectator"
    role = msg.role;
    roleP.innerText = `You are a ${role}`;
    if (role === "spectator") enableSpectator();
  }

  if (msg.type === "updateGameState") {
    // msg.state has { snake, blocks, food, players, highScores }
    renderGame(msg.state);
    updateUI(msg.state.players, msg.state.highScores);
  }

  if (msg.type === "gameOver") {
    alert("Game Over! You died.");
  }
};

// 7) Handle player movement keys
document.addEventListener("keydown", e => {
  if (role !== "player") return;
  const dirs = {
    ArrowUp:    { x: 0,  y: -1 },
    ArrowDown:  { x: 0,  y:  1 },
    ArrowLeft:  { x: -1, y:  0 },
    ArrowRight: { x: 1,  y:  0 }
  };
  if (dirs[e.key]) {
    socket.send(JSON.stringify({
      type: "changeDirection",
      direction: dirs[e.key]
    }));
  }
});

// 8) Spectator’s “place block” ability
function enableSpectator() {
  let ready = true;
  abilityBtn.disabled = false;
  abilityBtn.onclick = () => {
    if (!ready) return;
    const x = parseInt(prompt("Block X (0–19):"), 10);
    const y = parseInt(prompt("Block Y (0–19):"), 10);
    socket.send(JSON.stringify({ type: "placeBlock", x, y }));
    ready = false;
    abilityBtn.disabled = true;
    setTimeout(() => { 
      ready = true; 
      abilityBtn.disabled = false; 
    }, 60000);
  };
}

// 9) “Refresh Game” button logic → send { type: "reset" }
refreshBtn.onclick = () => {
  socket.send(JSON.stringify({ type: "reset" }));
};

// 10) Draw the game board: snake, blocks, and food
function renderGame(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw snake (green)
  ctx.fillStyle = "#0f0";
  state.snake.forEach(p => {
    ctx.fillRect(p.x * 20, p.y * 20, 20, 20);
  });

  // Draw blocks (red)
  ctx.fillStyle = "red";
  state.blocks.forEach(b => {
    ctx.fillRect(b.x * 20, b.y * 20, 20, 20);
  });

  // Draw food (yellow)
  if (state.food) {
    ctx.fillStyle = "yellow";
    ctx.fillRect(state.food.x * 20, state.food.y * 20, 20, 20);
  }
}

// 11) Update the “Players Online” and “High Scores” sidebar
function updateUI(players, highScores) {
  // Players online (list each with a small “role” tag)
  playersList.innerHTML = players
    .map(p => 
      `<li>
         <span class="name">${p.name}</span>
         <span class="role-tag">${p.role}</span>
       </li>`
    ).join("");

  // High Scores (already sorted descending server-side)
  highscoreList.innerHTML = highScores
    .map(h => 
      `<li>
         <span class="name">${h.name}</span>
         <span class="score">${h.score}</span>
       </li>`
    ).join("");
}
