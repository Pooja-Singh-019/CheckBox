function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

const oneBoxApiBaseUrl = normalizeBaseUrl(
  window.ONEBOX_API_BASE_URL || window.ONEBOX_CONFIG?.apiBaseUrl || ""
);

const oneBoxWsBaseUrl = normalizeBaseUrl(
  window.ONEBOX_WS_BASE_URL || window.ONEBOX_CONFIG?.wsBaseUrl || oneBoxApiBaseUrl
);

function buildApiUrl(path) {
  return oneBoxApiBaseUrl ? `${oneBoxApiBaseUrl}${path}` : path;
}

function buildWsUrl(path) {
  if (oneBoxWsBaseUrl) {
    const wsBase = oneBoxWsBaseUrl
      .replace(/^http:/i, "ws:")
      .replace(/^https:/i, "wss:");
    return `${wsBase}${path}`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function isLikelyValidEmail(email) {
  const value = String(email || "").trim();
  if (!value || value.length > 254) {
    return false;
  }

  const parts = value.split("@");
  if (parts.length !== 2) {
    return false;
  }

  const [localPart, domainPart] = parts;
  if (!localPart || !domainPart) {
    return false;
  }

  if (localPart.startsWith(".") || localPart.endsWith(".")) {
    return false;
  }

  if (value.includes("..")) {
    return false;
  }

  const emailRegex =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

  return emailRegex.test(value);
}

class ThemeController {
  constructor({ toggleId }) {
    this.toggleEl = document.getElementById(toggleId);
    this.storageKey = "onebox:theme:v2";
    this.currentTheme = "light";

    if (!this.toggleEl) {
      return;
    }

    this.init();
  }

  init() {
    const saved = String(window.localStorage.getItem(this.storageKey) || "").toLowerCase();
    const initialTheme =
      saved === "dark" || saved === "light"
        ? saved
        : "light";

    this.applyTheme(initialTheme);
    this.toggleEl.addEventListener("click", () => {
      this.applyTheme(this.currentTheme === "dark" ? "light" : "dark");
    });
  }

  applyTheme(theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    this.currentTheme = nextTheme;

    document.body.classList.toggle("theme-dark", nextTheme === "dark");
    const iconEl = this.toggleEl.querySelector(".theme-toggle-icon");
    if (iconEl) {
      iconEl.textContent = nextTheme === "dark" ? "\u2600" : "\u263E";
    }

    this.toggleEl.setAttribute(
      "aria-label",
      nextTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"
    );

    window.localStorage.setItem(this.storageKey, nextTheme);
  }
}

class BunnyCelebration {
  constructor({ durationMs = 5000, particleCount = 320 } = {}) {
    this.durationMs = durationMs;
    this.particleCount = particleCount;
    this.styleId = "bunny-celebration-styles";
    this.isRunning = false;
  }

  
  startWinner(winnerName) {
    const text = winnerName
      ? `Congratulations, ${winnerName}! You found the Hunter and saved Bunny World. A new round will begin soon.`
      : "Hunter found! Bunny World is safe. New round starts soon.";

    this.start({
      text,
      tone: "winner",
      withParticles: true,
      durationMs: this.durationMs,
    });
  }

  startLoser(winnerName) {
    const text = winnerName
      ? `${winnerName} found the Hunter and saved Bunny World! Better luck in the next round.`
      : "Someone found the Hunter and saved Bunny World. Better luck next round.";

    this.start({
      text,
      tone: "loser",
      withParticles: false,
      durationMs: this.durationMs,
    });
  }

  start({ text, tone = "winner", withParticles = true, durationMs = this.durationMs }) {
    if (this.isRunning || document.querySelector(".bunny-celebration-overlay")) {
      return;
    }

    this.isRunning = true;
    this.injectStyles();

    const overlay = document.createElement("div");
    overlay.className = "bunny-celebration-overlay";

    const message = document.createElement("div");
    message.className = `bunny-celebration-message ${tone === "loser" ? "is-loser" : "is-winner"}`;
    message.textContent = text;

    overlay.appendChild(message);
    document.body.appendChild(overlay);

    if (withParticles) {
      this.createParticles(overlay);
    }

    window.setTimeout(() => {
      overlay.remove();
      this.isRunning = false;
    }, durationMs);
  }

  createParticles(overlay) {
    const symbols = [
      "\uD83E\uDD55",
      "\uD83E\uDD55",
      "\u2728",
      "\uD83C\uDF89",
      "\u2B50",
      "\uD83C\uDF1F",
      "\uD83D\uDCAB",
    ];

    const delayMax = Math.max(0, this.durationMs - 1200);

    for (let index = 0; index < this.particleCount; index++) {
      const particle = document.createElement("span");
      particle.className = "bunny-celebration-particle";
      particle.textContent = symbols[Math.floor(Math.random() * symbols.length)];

      const size = this.randomNumber(18, 38);
      const left = this.randomNumber(0, 100);
      const delay = this.randomNumber(0, delayMax);
      const fallDuration = this.randomNumber(2200, 5200);
      const drift = this.randomNumber(-140, 140);
      const rotate = this.randomNumber(180, 900);

      particle.style.left = `${left}%`;
      particle.style.fontSize = `${size}px`;
      particle.style.animationDelay = `${delay}ms`;
      particle.style.animationDuration = `${fallDuration}ms`;
      particle.style.setProperty("--drift-x", `${drift}px`);
      particle.style.setProperty("--rotate-deg", `${rotate}deg`);

      overlay.appendChild(particle);
    }
  }

  randomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  injectStyles() {
    if (document.getElementById(this.styleId)) {
      return;
    }

    const style = document.createElement("style");
    style.id = this.styleId;
    style.textContent = `
      .bunny-celebration-overlay {
        position: fixed;
        inset: 0;
        z-index: 999999;
        pointer-events: none;
        overflow: hidden;
      }

      .bunny-celebration-message {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.85);
        padding: 24px 34px;
        max-width: 720px;
        text-align: center;
        font-size: 34px;
        font-weight: 900;
        line-height: 1.25;
        color: #ffffff;
        border: 5px solid #ffffff;
        border-radius: 28px;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
        animation: bunnyCelebrationPop 900ms ease-out forwards,
                   bunnyCelebrationPulse 1200ms ease-in-out infinite;
      }

      .bunny-celebration-message.is-winner {
        background: linear-gradient(135deg, #7b1fa2, #ff9800);
      }

      .bunny-celebration-message.is-loser {
        background: linear-gradient(135deg, #1e3a8a, #0f766e);
        font-size: 29px;
      }

      .bunny-celebration-particle {
        position: absolute;
        top: -70px;
        user-select: none;
        animation-name: bunnyCarrotRain;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
        filter: drop-shadow(0 4px 4px rgba(0, 0, 0, 0.25));
      }

      @keyframes bunnyCarrotRain {
        0% {
          transform: translate3d(0, -80px, 0) rotate(0deg);
          opacity: 1;
        }

        100% {
          transform: translate3d(var(--drift-x), 110vh, 0) rotate(var(--rotate-deg));
          opacity: 0;
        }
      }

      @keyframes bunnyCelebrationPop {
        0% {
          transform: translate(-50%, -50%) scale(0.65);
          opacity: 0;
        }

        65% {
          transform: translate(-50%, -50%) scale(1.08);
          opacity: 1;
        }

        100% {
          transform: translate(-50%, -50%) scale(1);
          opacity: 1;
        }
      }

      @keyframes bunnyCelebrationPulse {
        0%, 100% {
          transform: translate(-50%, -50%) scale(1);
        }

        50% {
          transform: translate(-50%, -50%) scale(1.04);
        }
      }
    `;

    document.head.appendChild(style);
  }
}

class BunnyCheckboxGrid {
  constructor({ containerId, bunnyImageSrc, hunterImageSrc, onToggle }) {
    this.container = document.getElementById(containerId);
    this.bunnyImageSrc = bunnyImageSrc;
    this.hunterImageSrc = hunterImageSrc;
    this.onToggle = typeof onToggle === "function" ? onToggle : null;

    this.count = 0;
    this.hunterPosition = 1;
    this.readOnly = false;

    if (!this.container) {
      throw new Error(`Container not found: ${containerId}`);
    }
  }

  renderSnapshot({ count, hunterPosition, checkedPositions, readOnly }) {
    this.count = count;
    this.hunterPosition = hunterPosition;
    this.readOnly = Boolean(readOnly);

    const checkedSet = new Set(checkedPositions);
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < this.count; index++) {
      const position = index + 1;
      const isHunter = position === this.hunterPosition;

      const label = document.createElement("label");
      label.className = isHunter
        ? "bunny-checkbox hunter-checkbox"
        : "bunny-checkbox";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "bunny-checkbox";
      input.value = String(position);
      input.checked = checkedSet.has(position);
      input.disabled = this.readOnly;

      const img = document.createElement("img");
      img.src = isHunter ? this.hunterImageSrc : this.bunnyImageSrc;
      img.alt = isHunter ? "Hunter" : "Bunny";

      input.addEventListener("change", () => {
        if (this.readOnly) {
          input.checked = checkedSet.has(position);
          return;
        }

        if (!this.onToggle) {
          return;
        }

        this.onToggle({
          position,
          checked: input.checked,
        });
      });

      label.appendChild(input);
      label.appendChild(img);
      fragment.appendChild(label);
    }

    this.container.replaceChildren(fragment);
  }

  applyToggle({ position, checked }) {
    const input = this.container.querySelector(`input[value="${position}"]`);
    if (!input) {
      return;
    }

    input.checked = Boolean(checked);
  }

  applyCheckedPositions(checkedPositions) {
    const checkedSet = new Set(
      Array.isArray(checkedPositions)
        ? checkedPositions.map((value) => Number(value)).filter((value) => Number.isInteger(value))
        : []
    );

    for (const input of this.container.querySelectorAll("input[type='checkbox']")) {
      const position = Number(input.value);
      input.checked = checkedSet.has(position);
    }
  }

  setReadOnly(nextReadOnly) {
    this.readOnly = Boolean(nextReadOnly);

    for (const input of this.container.querySelectorAll("input[type='checkbox']")) {
      input.disabled = this.readOnly;
    }
  }

  getCheckedPositions() {
    const checkedPositions = [];

    for (const input of this.container.querySelectorAll("input[type='checkbox']")) {
      if (input.checked) {
        checkedPositions.push(Number(input.value));
      }
    }

    checkedPositions.sort((left, right) => left - right);
    return checkedPositions;
  }
}

class RealtimeGame {
  constructor({ grid, welcomeElementId, syncBadgeId, presenceTextId }) {
    this.grid = grid;
    this.socket = null;
    this.token = null;
    this.userId = null;
    this.reconnectTimer = null;
    this.snapshotPollTimer = null;
    this.lastSnapshotSignature = "";
    this.shouldReconnect = false;
    this.wsConnected = false;
    this.celebration = new BunnyCelebration({ durationMs: 9000, particleCount: 280 });
    this.welcomeEl = document.getElementById(welcomeElementId);
    this.syncBadgeEl = document.getElementById(syncBadgeId);
    this.presenceEl = document.getElementById(presenceTextId);
  }

  start({ token, user }) {
    this.token = token;
    this.userId = user?.id || null;
    this.shouldReconnect = true;
    this.updateWelcome(user?.name || "Guardian");
    this.updatePresence({ connectedSockets: 1, authenticatedSockets: 1 });
    this.setConnectionMode("connecting");
    this.loadSnapshot();
    this.connect();
  }

  stop() {
    this.shouldReconnect = false;
    this.token = null;
    this.userId = null;
    this.lastSnapshotSignature = "";
    this.stopSnapshotPolling();
    this.wsConnected = false;
    this.setConnectionMode("connecting");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  updateWelcome(name) {
    if (!this.welcomeEl) {
      return;
    }

    this.welcomeEl.textContent = `Welcome, ${name}`;
  }

  updatePresence({ connectedSockets, authenticatedSockets, authenticatedUsers }) {
    if (!this.presenceEl) {
      return;
    }

    const total = Number.isFinite(Number(authenticatedUsers))
      ? Number(authenticatedUsers)
      : Number.isFinite(Number(authenticatedSockets))
      ? Number(authenticatedSockets)
      : Number(connectedSockets || 1);
    this.presenceEl.textContent = `Players online: ${Math.max(1, total)}`;
  }

  setConnectionMode(mode) {
    if (!this.syncBadgeEl) {
      return;
    }

    this.syncBadgeEl.classList.remove("is-live", "is-fallback", "is-connecting");

    if (mode === "live") {
      this.syncBadgeEl.classList.add("is-live");
      this.syncBadgeEl.textContent = "Live sync";
      return;
    }

    if (mode === "fallback") {
      this.syncBadgeEl.classList.add("is-fallback");
      this.syncBadgeEl.textContent = "Backup sync";
      return;
    }

    this.syncBadgeEl.classList.add("is-connecting");
    this.syncBadgeEl.textContent = "Connecting...";
  }

  connect() {
    if (!this.token) {
      return;
    }

    const wsUrl = `${buildWsUrl("/ws")}?token=${encodeURIComponent(this.token)}`;

    this.setConnectionMode("connecting");
    this.socket = new WebSocket(wsUrl);

    this.socket.addEventListener("open", () => {
      this.wsConnected = true;
      this.setConnectionMode("live");
      this.stopSnapshotPolling();
      this.loadSnapshot();
    });

    this.socket.addEventListener("message", (event) => {
      this.handleSocketMessage(event.data);
    });

    this.socket.addEventListener("close", () => {
      this.socket = null;
      this.wsConnected = false;
      this.setConnectionMode("fallback");
      this.startSnapshotPolling();

      if (!this.shouldReconnect) {
        return;
      }

      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, 1500);
    });
  }

  async loadSnapshot() {
    try {
      const response = await fetch(buildApiUrl("/game/snapshot"), {
        headers: this.token
          ? {
              Authorization: `Bearer ${this.token}`,
            }
          : {},
      });

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      this.applySnapshot(payload);
    } catch {
      // Snapshot fallback is best-effort.
    }
  }

  applySnapshot(payload) {
    const signature = this.createSnapshotSignature(payload);
    if (signature && signature === this.lastSnapshotSignature) {
      return;
    }

    const nextCount = Number(payload?.count || 0);
    const nextHunterPosition = Number(payload?.hunterPosition || 0);
    const structureUnchanged =
      this.grid.count === nextCount &&
      this.grid.hunterPosition === nextHunterPosition &&
      this.grid.container?.children?.length === nextCount;

    if (structureUnchanged) {
      this.grid.applyCheckedPositions(payload?.checkedPositions || []);
      this.grid.setReadOnly(Boolean(payload?.readOnly));
    } else {
      this.grid.renderSnapshot(payload);
      this.grid.setReadOnly(Boolean(payload.readOnly));
    }

    this.lastSnapshotSignature = signature;
  }

  createSnapshotSignature(payload) {
    if (!payload || typeof payload !== "object") {
      return "";
    }

    const count = Number(payload.count || 0);
    const hunterPosition = Number(payload.hunterPosition || 0);
    const readOnly = Boolean(payload.readOnly);
    const checkedPositions = Array.isArray(payload.checkedPositions)
      ? payload.checkedPositions
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
          .sort((left, right) => left - right)
      : [];

    return `${count}|${hunterPosition}|${readOnly ? 1 : 0}|${checkedPositions.join(",")}`;
  }

  refreshSignatureFromGrid() {
    if (!this.grid?.count) {
      this.lastSnapshotSignature = "";
      return;
    }

    this.lastSnapshotSignature = this.createSnapshotSignature({
      count: this.grid.count,
      hunterPosition: this.grid.hunterPosition,
      checkedPositions: this.grid.getCheckedPositions(),
      readOnly: this.grid.readOnly,
    });
  }

  startSnapshotPolling() {
    this.stopSnapshotPolling();
    this.snapshotPollTimer = setInterval(() => {
      this.loadSnapshot();
    }, 5000);
  }

  stopSnapshotPolling() {
    if (!this.snapshotPollTimer) {
      return;
    }

    clearInterval(this.snapshotPollTimer);
    this.snapshotPollTimer = null;
  }

  handleSocketMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    switch (message.type) {
      case "snapshot": {
        this.applySnapshot(message.data);
        break;
      }

      case "checkbox:update": {
        this.grid.applyToggle(message.data);
        this.refreshSignatureFromGrid();
        break;
      }

      case "round:won": {
        const isWinner = this.userId && message.data.winnerUserId === this.userId;
        if (isWinner) {
          this.celebration.startWinner(message.data.winnerName);
        } else {
          this.celebration.startLoser(message.data.winnerName);
        }
        break;
      }

      case "round:reset": {
        this.applySnapshot({
          count: this.grid.count,
          hunterPosition: message.data.hunterPosition,
          checkedPositions: message.data.checkedPositions,
          readOnly: this.grid.readOnly,
        });
        break;
      }

      case "presence": {
        this.updatePresence(message.data || {});
        break;
      }

      case "error": {
        console.warn("socket_error", message.code, message.message);
        break;
      }

      default:
        break;
    }
  }

  sendToggle(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.sendToggleWithHttpFallback(payload);
      return;
    }

    this.socket.send(
      JSON.stringify({
        type: "checkbox:toggle",
        data: payload,
      })
    );
  }

  async sendToggleWithHttpFallback(payload) {
    if (!this.token) {
      return;
    }

    try {
      const response = await fetch(buildApiUrl("/game/toggle"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        return;
      }

      const result = await response.json();
      this.setConnectionMode("fallback");

      if (result?.won) {
        this.celebration.startWinner(result.winnerName || "Guardian");
      }

      this.loadSnapshot();
    } catch {
      // HTTP fallback is best-effort.
    }
  }
}



class AuthPortal {
  constructor({
    gateId,
    gameId,
    loginFormId,
    signupFormId,
    loginTabId,
    signupTabId,
    messageId,
    logoutId,
    titleId,
    subtitleId,
    onAuthenticated,
    onLoggedOut,
  }) {
    this.gate = document.getElementById(gateId);
    this.game = document.getElementById(gameId);
    this.loginForm = document.getElementById(loginFormId);
    this.signupForm = document.getElementById(signupFormId);
    this.authTabs = this.gate?.querySelector(".auth-tabs");
    this.loginTab = document.getElementById(loginTabId);
    this.signupTab = document.getElementById(signupTabId);
    this.message = document.getElementById(messageId);
    this.logoutBtn = document.getElementById(logoutId);
    this.titleEl = document.getElementById(titleId);
    this.subtitleEl = document.getElementById(subtitleId);
    this.authCard = this.gate?.querySelector(".auth-card");

    this.onAuthenticated = typeof onAuthenticated === "function" ? onAuthenticated : null;
    this.onLoggedOut = typeof onLoggedOut === "function" ? onLoggedOut : null;
    this.apiBaseUrl = oneBoxApiBaseUrl;
    this.currentMode = "login";
    this.modeShiftTimer = null;

    this.localSessionKey = "onebox:session:local:v1";
    this.sessionSessionKey = "onebox:session:session:v1";

    if (
      !this.gate ||
      !this.game ||
      !this.loginForm ||
      !this.signupForm ||
      !this.authTabs ||
      !this.loginTab ||
      !this.signupTab ||
      !this.message ||
      !this.logoutBtn ||
      !this.titleEl ||
      !this.subtitleEl ||
      !this.authCard
    ) {
      throw new Error("Auth portal elements are missing.");
    }
  }

  async init() {
    this.loginTab.addEventListener("click", () => this.switchMode("login"));
    this.signupTab.addEventListener("click", () => this.switchMode("signup"));

    this.loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.handleLogin();
    });

    this.signupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.handleSignup();
    });

    this.logoutBtn.addEventListener("click", () => this.logout());

    const session = this.getStoredSession();
    if (session) {
      const valid = await this.validateToken(session.token);
      if (valid) {
        this.unlock(session.user?.name || "Guardian");
        if (this.onAuthenticated) {
          this.onAuthenticated(session);
        }
        return;
      }
    }

    this.clearStoredSession();
    this.lock();
  }

  switchMode(mode) {
    const showLogin = mode === "login";
    const previousMode = this.currentMode;

    this.loginForm.classList.toggle("is-hidden", !showLogin);
    this.signupForm.classList.toggle("is-hidden", showLogin);
    this.loginTab.classList.toggle("is-active", showLogin);
    this.signupTab.classList.toggle("is-active", !showLogin);
    this.loginTab.setAttribute("aria-selected", showLogin ? "true" : "false");
    this.signupTab.setAttribute("aria-selected", !showLogin ? "true" : "false");
    this.authTabs.dataset.mode = showLogin ? "login" : "signup";

    this.titleEl.textContent = showLogin
      ? "Welcome Back, Guardian"
      : "Join the Bunny Rescue Team";
    this.subtitleEl.textContent = showLogin
      ? "Login to continue your bunny rescue mission."
      : "Create your account to hunt down the hidden hunter.";

    this.playFormEntrance(showLogin ? this.loginForm : this.signupForm, mode);

    if (previousMode !== mode) {
      this.playModeShift(mode);
    }

    this.currentMode = mode;
    this.clearMessage();
  }

  playModeShift(mode) {
    const shiftClass = mode === "signup" ? "mode-shift-signup" : "mode-shift-login";
    const opposite = mode === "signup" ? "mode-shift-login" : "mode-shift-signup";

    this.authCard.classList.remove(opposite, shiftClass);
    void this.authCard.offsetWidth;
    this.authCard.classList.add(shiftClass);
    this.authTabs.classList.remove("mode-shift");
    void this.authTabs.offsetWidth;
    this.authTabs.classList.add("mode-shift");

    if (this.modeShiftTimer) {
      clearTimeout(this.modeShiftTimer);
    }

    this.modeShiftTimer = setTimeout(() => {
      this.authCard.classList.remove(shiftClass);
      this.authTabs.classList.remove("mode-shift");
      this.modeShiftTimer = null;
    }, 620);
  }

  playFormEntrance(formEl, mode) {
    formEl.classList.remove("mode-enter", "mode-enter-login", "mode-enter-signup");
    void formEl.offsetWidth;
    formEl.classList.add("mode-enter");
    formEl.classList.add(mode === "signup" ? "mode-enter-signup" : "mode-enter-login");

    setTimeout(() => {
      formEl.classList.remove("mode-enter", "mode-enter-login", "mode-enter-signup");
    }, 380);
  }

  apiUrl(path) {
    return buildApiUrl(path);
  }

  async fetchJson(path, options = {}) {
    const response = await fetch(this.apiUrl(path), options);
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      return {
        response,
        payload: await response.json(),
      };
    }

    await response.text();
    return {
      response,
      payload: {
        message: "",
      },
    };
  }

  async getHealthInfo() {
    try {
      const { response, payload } = await this.fetchJson("/health");
      if (!response.ok || !payload || typeof payload !== "object") {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  getServerReachableMessage() {
    if (this.apiBaseUrl) {
      return "Server is not reachable. Check backend URL and CORS settings.";
    }

    return "Server is not reachable. Configure ONEBOX_API_BASE_URL and ONEBOX_WS_BASE_URL in index.html.";
  }

  async handleSignup() {
    const data = new FormData(this.signupForm);
    const name = String(data.get("name") || "").trim();
    const email = String(data.get("email") || "").trim().toLowerCase();
    const password = String(data.get("password") || "").trim();
    const confirmPassword = String(data.get("confirmPassword") || "").trim();

    if (!isLikelyValidEmail(email)) {
      this.setMessage("Please enter a valid email address.");
      return;
    }

    if (password !== confirmPassword) {
      this.setMessage("Password and confirm password do not match.");
      return;
    }

    try {
      const { response, payload } = await this.fetchJson("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (!response.ok) {
        const fallbackMessage = this.apiBaseUrl
          ? "Unable to create account."
          : this.getServerReachableMessage();
        this.setMessage(payload.message || fallbackMessage);
        return;
      }

      this.signupForm.reset();
      this.switchMode("login");
      const loginEmailInput = this.loginForm.querySelector("#loginEmail");
      if (loginEmailInput) {
        loginEmailInput.value = email;
      }

      this.setMessage("Account created successfully. Login with your email.", true);

    } catch {
      this.setMessage(this.getServerReachableMessage());
    }
  }

  async handleLogin() {
    const data = new FormData(this.loginForm);
    const email = String(data.get("email") || "").trim().toLowerCase();
    const password = String(data.get("password") || "").trim();
    const remember = this.loginForm.querySelector("#rememberMe")?.checked === true;

    if (!isLikelyValidEmail(email)) {
      this.setMessage("Please enter a valid email address.");
      return;
    }

    try {
      const { response, payload } = await this.fetchJson("/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          username: email,
          password,
        }),
      });

      if (!response.ok) {
        if (payload.error === "invalid_credentials") {
          const health = await this.getHealthInfo();
          if (health?.database === "memory") {
            this.setMessage(
              "Server storage was reset, so this account is gone. Create account again, or use Postgres DB on Render."
            );
            return;
          }

          const apiHost = String(this.apiBaseUrl || "").toLowerCase();
          const isRenderHost = apiHost.includes(".onrender.com");
          if (isRenderHost && health?.database === "sqlite") {
            this.setMessage(
              "This Render service uses temporary SQLite storage. After restart/deploy, accounts can reset. Use Postgres DB for stable login."
            );
            return;
          }
        }

        const fallbackMessage = this.apiBaseUrl
          ? "Login failed."
          : this.getServerReachableMessage();
        this.setMessage(payload.message || fallbackMessage);
        return;
      }

      const session = {
        token: payload.access_token,
        user: payload.user,
      };

      this.storeSession(session, remember);
      this.loginForm.reset();
      this.clearMessage();
      this.unlock(payload.user?.name || "Guardian");

      if (this.onAuthenticated) {
        this.onAuthenticated(session);
      }
    } catch {
      this.setMessage(this.getServerReachableMessage());
    }
  }

  async validateToken(token) {
    try {
      const response = await fetch(this.apiUrl("/auth/userinfo"), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  lock() {
    this.gate.classList.add("is-visible");
    this.game.classList.add("is-hidden");
    this.switchMode("login");
  }

  unlock(name) {
    this.gate.classList.remove("is-visible");
    this.game.classList.remove("is-hidden");
    this.game.classList.remove("game-shell-enter");
    void this.game.offsetWidth;
    this.game.classList.add("game-shell-enter");
    setTimeout(() => {
      this.game.classList.remove("game-shell-enter");
    }, 520);

    const welcomeEl = document.getElementById("welcomeText");
    if (welcomeEl) {
      welcomeEl.textContent = `Welcome, ${name}`;
    }
  }

  logout() {
    this.clearStoredSession();
    this.lock();

    if (this.onLoggedOut) {
      this.onLoggedOut();
    }
  }

  storeSession(session, remember) {
    const localPayload = remember ? JSON.stringify(session) : "";
    const sessionPayload = remember ? "" : JSON.stringify(session);

    if (localPayload) {
      window.localStorage.setItem(this.localSessionKey, localPayload);
      window.sessionStorage.removeItem(this.sessionSessionKey);
      return;
    }

    window.sessionStorage.setItem(this.sessionSessionKey, sessionPayload);
    window.localStorage.removeItem(this.localSessionKey);
  }

  getStoredSession() {
    const local = window.localStorage.getItem(this.localSessionKey);
    if (local) {
      try {
        return JSON.parse(local);
      } catch {
        return null;
      }
    }

    const session = window.sessionStorage.getItem(this.sessionSessionKey);
    if (!session) {
      return null;
    }

    try {
      return JSON.parse(session);
    } catch {
      return null;
    }
  }

  clearStoredSession() {
    window.localStorage.removeItem(this.localSessionKey);
    window.sessionStorage.removeItem(this.sessionSessionKey);
  }

  setMessage(text, success = false) {
    this.message.textContent = text;
    this.message.classList.toggle("is-success", success);
  }

  clearMessage() {
    this.message.textContent = "";
    this.message.classList.remove("is-success");
  }
}

const grid = new BunnyCheckboxGrid({
  containerId: "bunnyGrid",
  bunnyImageSrc: "./bunny.png",
  hunterImageSrc: "./Hunter.png",
  onToggle: (payload) => realtimeGame.sendToggle(payload),
});

const realtimeGame = new RealtimeGame({
  grid,
  welcomeElementId: "welcomeText",
  syncBadgeId: "syncBadge",
  presenceTextId: "presenceText",
});

new ThemeController({
  toggleId: "themeToggle",
});

const authPortal = new AuthPortal({
  gateId: "authGate",
  gameId: "gameShell",
  loginFormId: "loginForm",
  signupFormId: "signupForm",
  loginTabId: "loginTab",
  signupTabId: "signupTab",
  messageId: "authMessage",
  logoutId: "logoutBtn",
  titleId: "authTitle",
  subtitleId: "authSubtitle",
  onAuthenticated: (session) => realtimeGame.start(session),
  onLoggedOut: () => realtimeGame.stop(),
});

authPortal.init();



