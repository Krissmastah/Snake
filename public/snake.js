// public/snake.js

window.addEventListener("DOMContentLoaded", () => {
  // ── 1) Grab DOM elements ───────────────────────────────────────────────
  const canvas        = document.getElementById("gameCanvas");
  const ctx           = canvas.getContext("2d");
  const playersList   = document.getElementById("playersList");
  const highscoreList = document.getElementById("highscoreList");
  const roleP         = document.getElementById("role");
  const abilityBtn    = document.getElementById("useAbility");
  const refreshBtn    = document.getElementById("refreshBtn");
  const loginBtn      = document.getElementById("loginBtn");
  const registerBtn   = document.getElementById("registerBtn");
  const guestBtn      = document.getElementById("guestBtn");

  // ── 2) State variables ─────────────────────────────────────────────────
  let username     = null;
  let role         = null;      // “player” or “spectator”
  let ws           = null;      // WebSocket instance
  window.JWT_TOKEN = null;      // will hold JWT after login

  // Create a “Start” button (initially hidden)
  const startBtn = document.createElement("button");
  startBtn.innerText = "Start Game";
  startBtn.style.position = "absolute";
  startBtn.style.top = "50%";
  startBtn.style.left = "50%";
  startBtn.style.transform = "translate(-50%, -50%)";
  startBtn.style.padding = "1rem 2rem";
  startBtn.style.fontSize = "1.2rem";
  startBtn.style.zIndex = "1000";
  startBtn.style.display = "none";
  document.body.appendChild(startBtn);

  // ── 3) Utility: Show messages to user ───────────────────────────────────
  function showError(msg) {
    alert("❌ " + msg);
  }

  // ── 4) Handle Login ────────────────────────────────────────────────────
  loginBtn.onclick = async () => {
    const user = prompt("Username:");
    const pass = prompt("Password:");
    if (!user || !pass) {
      showError("Username and password required.");
      return;
    }
    try {
      const res = await fetch(`${window.BACKEND_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || "Login failed");
        return;
      }
      // Store JWT and username, then enable “Start Game” instead of auto-join
      window.JWT_TOKEN = data.token;
      username = user;

      // Show the “Start Game” button now that we’re authenticated
      startBtn.style.display = "block";
      startBtn.onclick = () => {
        sendJoin();
        startBtn.style.display = "none";
      };
    } catch (e) {
      showError("Login request failed");
    }
  };

  // ── 5) Handle Register ─────────────────────────────────────────────────
  registerBtn.onclick = async () => {
    const user = prompt("Choose a username:");
    const pass = prompt("Choose a password:");
    if (!user || !pass) {
      showError("Username and password required.");
      return;
    }
    try {
      const res = await fetch(`${window.BACKEND_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || "Register failed");
        return;
      }
      alert("✅ Registration successful! Please log in now.");
    } catch (e) {
      showError("Register request failed");
    }
  };

  // ── 6) Handle “Play as Guest” ──────────────────────────────────────────
  guestBtn.onclick = () => {
    username = `Guest${Math.floor(Math.random() * 10000)}`;
    window.JWT_TOKEN = null;

    // Show “Start Game” button for guest mode
    startBtn.style.display = "block";
    startBtn.onclick = () => {
      sendJoin();
      startBtn.style.display = "none";
    };
  };

  // ── 7) Helper: send a JOIN message (for player to become “currentPlayer”) ─
  function sendJoin() {
    if (!ws) {
      // Only create WebSocket connection on first join
      initializeWebSocket(/* isGuest= */ username.startsWith("Guest"));
      return;
    }
    // If WS already open, just send the join payload
    ws.send(JSON.stringify({ type: "join", name: username }));
  }

  // ── 8) Initialize WebSocket (but DO NOT auto-join until user clicks Start) ─
  function initializeWebSocket(isGuest = false) {
    // Build WebSocket URL (same “wss://” vs “ws://” logic)
    let wsUrl;
    if (window.BACKEND_URL.startsWith("https://")) {
      wsUrl = "wss://" + window.BACKEND_URL.slice(8);
    } else if (window.BACKEND_URL.startsWith("http://")) {
      wsUrl = "ws://" + window.BACKEND_URL.slice(7);
    } else {
      showError("Invalid BACKEND_URL protocol.");
      return;
    }

    if (!isGuest) {
      wsUrl += `?token=${window.JWT_TOKEN}`;
    } else {
      wsUrl += "?guest=true";
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // If startBtn was clicked, then send join right away.
      // Otherwise, do nothing until sendJoin() is called.
    };

    ws.onerror = err => {
      console.error("WebSocket error:", err);
      showError("WebSocket connection failed.");
    };

    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);

      if (msg.type === "roleAssignment") {
        role = msg.role;
        roleP.innerText = `You are a ${role}`;

        if (role === "spectator") {
          abilityBtn.disabled = false;
        }
      }

      if (msg.type === "updateGameState") {
        renderGame(msg.state);
        updateUI(msg.state.players, msg.state.highScores);
      }

      if (msg.type === "gameOver") {
        // Show an alert and then re-display the “Start Game” button
        alert("Game Over! You died.");

        // Let the user click Start again (to re-join)
        startBtn.style.display = "block";
        startBtn.onclick = () => {
          sendJoin();
          startBtn.style.display = "none";
        };
      }
    };

    ws.onclose = () => {
      showError("WebSocket closed. Refresh to reconnect.");
    };
  }

  // ── 9) Handle player movement keys ─────────────────────────────────────
  document.addEventListener("keydown", e => {
    if (!ws || role !== "player") return;
    const dirs = {
      ArrowUp:    { x: 0,  y: -1 },
      ArrowDown:  { x: 0,  y:  1 },
      ArrowLeft:  { x: -1, y:  0 },
      ArrowRight: { x: 1,  y:  0 }
    };
    if (dirs[e.key]) {
      ws.send(JSON.stringify({
        type: "changeDirection",
        direction: dirs[e.key]
      }));
    }
  });

  // ── 10) Spectator’s “place block” ability ───────────────────────────────
  function enableSpectator() {
    let ready = true;
    abilityBtn.disabled = false;
    abilityBtn.onclick = () => {
      if (!ready || !ws) return;
      const x = parseInt(prompt("Block X (0–19):"), 10);
      const y = parseInt(prompt("Block Y (0–19):"), 10);
      ws.send(JSON.stringify({ type: "placeBlock", x, y }));
      ready = false;
      abilityBtn.disabled = true;
      setTimeout(() => {
        ready = true;
        abilityBtn.disabled = false;
      }, 60000);
    };
  }

  // ── 11) Refresh Game → send { type: "reset" } ───────────────────────────
  refreshBtn.onclick = () => {
    if (ws) ws.send(JSON.stringify({ type: "reset" }));
  };

  // ── 12) Draw the game board: snake, blocks, and food ───────────────────
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

  // ── 13) Update the “Players Online” and “High Scores” sidebar ──────────
  function updateUI(players, highScores) {
    // Players online (name + role)
    playersList.innerHTML = players
      .map(p =>
        `<li>
           <span class="name">${p.name}</span>
           <span class="role-tag">${p.role}</span>
         </li>`
      ).join("");

    // High Scores (sorted top 10 by server)
    highscoreList.innerHTML = highScores
      .map(h =>
        `<li>
           <span class="name">${h.name}</span>
           <span class="score">${h.score}</span>
         </li>`
      ).join("");
  }
});
