// public/snake.js

// 1) Grab the canvas and context
const canvas = document.getElementById("gameCanvas");
const ctx    = canvas.getContext("2d");

// 2) Ask the player for their name
let playerName = prompt("Enter your name:");
let role       = "spectator";

// 3) Determine the backend URL (hard-coded for now)
const BACKEND_URL = window.BACKEND_URL || "https://snake-15x2.onrender.com";

// 4) Build the ws:// or wss:// URL and open the socket
const socketUrl = BACKEND_URL.replace(/^http/, "ws");
console.log("Attempting WebSocket to:", socketUrl);
const socket    = new WebSocket(socketUrl);

// 5) When connected, tell the server we’re joining
socket.onopen = () => {
  console.log("WebSocket open");
  socket.send(JSON.stringify({ type: "join", name: playerName }));
};

// 6) Log any errors
socket.onerror = err => {
  console.error("WebSocket error:", err);
};

// 7) Handle incoming messages
socket.onmessage = event => {
  const msg = JSON.parse(event.data);
  console.log("WS message:", msg);

  if (msg.type === "roleAssignment") {
    role = msg.role;
    document.getElementById("role").innerText = `You are a ${role}`;
    if (role === "spectator") startSpectatorAbilityCooldown();
  }

  if (msg.type === "updateGameState") {
    renderGame(msg.state);
  }

  if (msg.type === "gameOver") {
    alert("Game Over! Resetting…");
  }
};

// 8) Send player movement commands
document.addEventListener("keydown", e => {
  if (role !== "player") return;
  let dir = null;
  if (e.key === "ArrowUp")    dir = { x: 0,  y: -1 };
  if (e.key === "ArrowDown")  dir = { x: 0,  y: 1 };
  if (e.key === "ArrowLeft")  dir = { x: -1, y: 0 };
  if (e.key === "ArrowRight") dir = { x: 1,  y: 0 };
  if (dir) {
    socket.send(JSON.stringify({ type: "changeDirection", direction: dir }));
  }
});

// 9) Spectator’s block-placing cooldown
function startSpectatorAbilityCooldown() {
  const btn   = document.getElementById("useAbility");
  let   ready = true;
  btn.disabled = false;
  btn.onclick  = () => {
    if (!ready) return;
    const x = parseInt(prompt("Block X position (0–19):"), 10);
    const y = parseInt(prompt("Block Y position (0–19):"), 10);
    socket.send(JSON.stringify({ type: "placeBlock", x, y }));
    ready = false;
    btn.disabled = true;
    setTimeout(() => { ready = true; btn.disabled = false; }, 60000);
  };
}

// 10) Render loop: snakes, blocks, and food
function renderGame(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw all snakes
  state.snakes.forEach((snake, idx) => {
    ctx.fillStyle = idx === 0 ? "#0f0" : "#00f";
    snake.forEach(p => ctx.fillRect(p.x * 20, p.y * 20, 20, 20));
  });

  // Draw blocks
  ctx.fillStyle = "red";
  state.blocks.forEach(b => ctx.fillRect(b.x * 20, b.y * 20, 20, 20));

  // Draw the food pellet
  const f = state.food;
  ctx.fillStyle = "yellow";
  ctx.fillRect(f.x * 20, f.y * 20, 20, 20);
}
