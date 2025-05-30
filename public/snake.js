// public/snake.js

// Grab elements
const canvas      = document.getElementById("gameCanvas");
const ctx         = canvas.getContext("2d");
const playersList = document.getElementById("playersList");
const scoreboard  = document.getElementById("scoreboard");
const roleP       = document.getElementById("role");
const abilityBtn  = document.getElementById("useAbility");

// Prompt and connect
let playerName = prompt("Enter your name:") || "Anon";
let role       = "spectator";
const BACKEND_URL = window.BACKEND_URL;
const socket      = new WebSocket(BACKEND_URL.replace(/^http/, "ws"));

// Join on open
socket.onopen = () => {
  socket.send(JSON.stringify({ type: "join", name: playerName }));
};

// Handle errors
socket.onerror = err => console.error("WS error", err);

// Handle incoming messages
socket.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "roleAssignment") {
    role = msg.role;
    roleP.innerText = `You are a ${role}`;
    if (role === "spectator") enableSpectator();
  }
  if (msg.type === "updateGameState") {
    renderGame(msg.state);
    updateUI(msg.state.players);
  }
  if (msg.type === "gameOver") {
    alert("Game Over! Resetting…");
  }
};

// Player movement
document.addEventListener("keydown", e => {
  if (role !== "player") return;
  const dirs = {
    ArrowUp:    { x: 0,  y: -1 },
    ArrowDown:  { x: 0,  y: 1 },
    ArrowLeft:  { x: -1, y: 0 },
    ArrowRight: { x: 1,  y: 0 }
  };
  if (dirs[e.key]) {
    socket.send(JSON.stringify({ type: "changeDirection", direction: dirs[e.key] }));
  }
});

// Spectator block ability
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
    setTimeout(() => { ready = true; abilityBtn.disabled = false; }, 60000);
  };
}

// Render the game state
function renderGame(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw snake
  ctx.fillStyle = "#0f0";
  state.snake.forEach(p =>
    ctx.fillRect(p.x * 20, p.y * 20, 20, 20)
  );

  // Draw blocks
  ctx.fillStyle = "red";
  state.blocks.forEach(b =>
    ctx.fillRect(b.x * 20, b.y * 20, 20, 20)
  );

  // Draw food
  if (state.food) {
    ctx.fillStyle = "yellow";
    ctx.fillRect(state.food.x * 20, state.food.y * 20, 20, 20);
  }
}

// Update sidebar lists
function updateUI(players) {
  // Players online
  playersList.innerHTML = players
    .map(p => `<li>${p.name} (${p.role})</li>`)
    .join("");

  // Scoreboard (sorted desc)
  scoreboard.innerHTML = players
    .slice() // copy before sort
    .sort((a, b) => b.score - a.score)
    .map(p => `<li>${p.name}: ${p.score}</li>`)
    .join("");
}
