// public/snake.js

// 1) Grab the canvas and context
const canvas = document.getElementById("gameCanvas");
const ctx    = canvas.getContext("2d");

// 2) Ask the player for their name
let playerName = prompt("Enter your name:");
let role       = "spectator";

// 3) Connect to your Render back-end
const BACKEND_URL = window.BACKEND_URL || "https://snake-15x2.onrender.com";
const socket      = new WebSocket(BACKEND_URL.replace(/^http/, "ws"));

socket.onopen = () => {
  console.log("WS open, joining as", playerName);
  socket.send(JSON.stringify({ type: "join", name: playerName }));
};

socket.onerror = err => console.error("WS error", err);

socket.onmessage = event => {
  const msg = JSON.parse(event.data);
  console.log("WS message:", msg);

  if (msg.type === "roleAssignment") {
    role = msg.role;
    document.getElementById("role").innerText = `You are a ${role}`;
    if (role === "spectator") startSpectatorAbilityCooldown();
  }

  if (msg.type === "updateGameState") {
    // For debugging, you can uncomment this:
    // console.log("state keys:", Object.keys(msg.state), msg.state);
    renderGame(msg.state);
  }

  if (msg.type === "gameOver") {
    alert("Game Over! Resetting…");
  }
};

// 4) Handle player movement
document.addEventListener("keydown", e => {
  if (role !== "player") return;
  let dir = null;
  if (e.key === "ArrowUp")    dir = { x: 0,  y: -1 };
  if (e.key === "ArrowDown")  dir = { x: 0,  y: 1 };
  if (e.key === "ArrowLeft")  dir = { x: -1, y: 0 };
  if (e.key === "ArrowRight") dir = { x: 1,  y: 0 };
  if (dir) socket.send(JSON.stringify({ type: "changeDirection", direction: dir }));
});

// 5) Spectator’s block‐placing cooldown
function startSpectatorAbilityCooldown() {
  const btn   = document.getElementById("useAbility");
  let   ready = true;
  btn.disabled = false;

  btn.onclick = () => {
    if (!ready) return;
    const x = parseInt(prompt("Block X (0–19):"), 10);
    const y = parseInt(prompt("Block Y (0–19):"), 10);
    socket.send(JSON.stringify({ type: "placeBlock", x, y }));
    ready = false;
    btn.disabled = true;
    setTimeout(() => { ready = true; btn.disabled = false; }, 60000);
  };
}

// 6) Render function (must match server’s state shape)
function renderGame(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw the snake (server sends `state.snake`, not `state.snakes`)
  ctx.fillStyle = "#0f0";
  state.snake.forEach(p =>
    ctx.fillRect(p.x * 20, p.y * 20, 20, 20)
  );

  // Draw blocks
  ctx.fillStyle = "red";
  state.blocks.forEach(b =>
    ctx.fillRect(b.x * 20, b.y * 20, 20, 20)
  );

  // Draw food if present
  if (state.food) {
    ctx.fillStyle = "yellow";
    ctx.fillRect(state.food.x * 20, state.food.y * 20, 20, 20);
  }
}
