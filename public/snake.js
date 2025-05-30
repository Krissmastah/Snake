const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
let playerName = prompt("Enter your name:");
let role = "spectator";

// 1) Grab the URL (from our hard-coded script in index.html)
const BACKEND_URL = window.BACKEND_URL || "https://snakesnape.netlify.app/";

// 2) Build the WS URL (https→wss, http→ws)
const socketUrl = BACKEND_URL.replace(/^http/, "ws");
console.log("Attempting WebSocket to:", socketUrl);

// 3) Open the socket
const socket = new WebSocket(socketUrl);

socket.onopen = () => {
  console.log("WebSocket open");
  socket.send(JSON.stringify({ type: "join", name: playerName }));
};

socket.onerror = err => {
  console.error("WebSocket error:", err);
};

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

document.addEventListener("keydown", e => {
  if (role !== "player") return;
  let dir = null;
  if (e.key === "ArrowUp") dir = { x: 0, y: -1 };
  if (e.key === "ArrowDown") dir = { x: 0, y: 1 };
  if (e.key === "ArrowLeft") dir = { x: -1, y: 0 };
  if (e.key === "ArrowRight") dir = { x: 1, y: 0 };
  if (dir) socket.send(JSON.stringify({ type: "changeDirection", direction: dir }));
});

function startSpectatorAbilityCooldown() {
  const button = document.getElementById("useAbility");
  let canUse = true;
  button.disabled = false;
  button.onclick = () => {
    if (!canUse) return;
    const x = parseInt(prompt("Block X position (0–19):"), 10);
    const y = parseInt(prompt("Block Y position (0–19):"), 10);
    socket.send(JSON.stringify({ type: "placeBlock", x, y }));
    canUse = false;
    button.disabled = true;
    setTimeout(() => {
      canUse = true;
      button.disabled = false;
    }, 60000);
  };
}

function renderGame(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // draw all snakes
  state.snakes.forEach((snake, idx) => {
    ctx.fillStyle = idx === 0 ? "#0f0" : "#00f";
    snake.forEach(p => ctx.fillRect(p.x * 20, p.y * 20, 20, 20));
  });

  // draw blocks
  ctx.fillStyle = "red";
  state.blocks.forEach(b => ctx.fillRect(b.x * 20, b.y * 20, 20, 20));

  // draw food
  const f = state.food;
  ctx.fillStyle = "yellow";
  ctx.fillRect(f.x * 20, f.y * 20, 20, 20);
}
