// Hent canvas og kontekst som før
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// Prompt brukernavn
let playerName = prompt("Enter your name:");
let role = "spectator";

// --- Her er endringen: bruk BACKEND_URL fra window-objektet ---
const BACKEND_URL = window.BACKEND_URL;
const socket = new WebSocket(`${BACKEND_URL.replace(/^http/, "ws")}`);

// Når tilkoblingen er åpen, send join-melding
socket.onopen = () => {
  socket.send(JSON.stringify({ type: "join", name: playerName }));
};

// Mottak av meldinger
socket.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "roleAssignment") {
    role = msg.role;
    document.getElementById("role").innerText = `You are a ${role}`;
    if (role === "spectator") {
      startSpectatorAbilityCooldown();
    }
  }

  if (msg.type === "updateGameState") {
    renderGame(msg.state);
  }

  if (msg.type === "gameOver") {
    alert("Game Over! Spectator sabotage was successful.");
  }
};

// Tastetrykk for spilleren
document.addEventListener("keydown", (e) => {
  if (role !== "player") return;
  let dir = null;
  if (e.key === "ArrowUp") dir = { x: 0, y: -1 };
  if (e.key === "ArrowDown") dir = { x: 0, y: 1 };
  if (e.key === "ArrowLeft") dir = { x: -1, y: 0 };
  if (e.key === "ArrowRight") dir = { x: 1, y: 0 };
  if (dir) {
    socket.send(JSON.stringify({ type: "changeDirection", direction: dir }));
  }
});

function startSpectatorAbilityCooldown() {
  const button = document.getElementById("useAbility");
  let canUse = true;

  button.onclick = () => {
    if (!canUse) return;
    const x = parseInt(prompt("Block X position (0–19):"));
    const y = parseInt(prompt("Block Y position (0–19):"));
    socket.send(JSON.stringify({ type: "placeBlock", x, y }));
    canUse = false;
    button.disabled = true;
    setTimeout(() => {
      canUse = true;
      button.disabled = false;
    }, 60000);
  };

  button.disabled = false;
}

function renderGame(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0f0";
  state.snake.forEach(p => ctx.fillRect(p.x * 20, p.y * 20, 20, 20));

  ctx.fillStyle = "red";
  state.blocks.forEach(b => ctx.fillRect(b.x * 20, b.y * 20, 20, 20));
}
