/**
 * OnlineServerClient — клиентский сетевой модуль онлайн-мультиплеера TicTacToeA_VK.
 * Обеспечивает взаимодействие с Cloudflare Worker и Durable Objects по протоколу WebSocket.
 * 
 * Отвечает за:
 * - получение игрового токена через /api/auth;
 * - подключение к очереди поиска соперников (Matchmaker DO);
 * - отмену поиска;
 * - подключение к игровой комнате матча (Match DO);
 * - отправку ходов с порядковыми номерами (seq);
 * - получение подтверждённых ходов, срезов состояния (snapshot) и итогов партии;
 * - reconnect при сбоях связи и перезагрузке страницы.
 */

export class OnlineServerClient extends EventTarget {
    constructor(config = {}) {
        super();

        this.platformAdapter = config.platformAdapter || null;
        this.serverUrl = config.serverUrl || this._detectServerUrl();
        this.wsUrl = config.wsUrl || this._deriveWsUrl(this.serverUrl);
        this.devUser = config.devUser || (this.platformAdapter ? (this.platformAdapter.mode === "development" ? this.platformAdapter.getUserId() : null) : this._detectDevUser());
        this.launchParams = config.launchParams || (this.platformAdapter?.mode === "vk_mini_apps" ? this.platformAdapter.getLaunchParams() : this._detectLaunchParams());

        this.token = null;
        this.userId = null;
        this.currentMatchId = null;
        this.role = null; // 'X' | 'O'
        this.seq = 0;
        this.state = "idle"; // 'idle' | 'authenticating' | 'searching' | 'connecting' | 'active' | 'paused' | 'completed' | 'error'

        this._socket = null;
        this._heartbeatInterval = null;
        this._activeMatchInfo = null;
        this._listeners = new Map();
    }

    // --- Определение URL и параметров окружения ---

    _detectServerUrl() {
        if (typeof window !== "undefined") {
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get("server")) {
                return urlParams.get("server");
            }
            if (window.TICTACTOE_ONLINE_CONFIG?.serverUrl) {
                return window.TICTACTOE_ONLINE_CONFIG.serverUrl;
            }
            // Если запущено локально (localhost, 127.0.0.1 или file:)
            const hostname = window.location.hostname;
            if (hostname === "localhost" || hostname === "127.0.0.1" || !hostname) {
                return "http://localhost:8787";
            }
        }
        return "https://tictactoe-vk-server.egorpcp.workers.dev";
    }

    _deriveWsUrl(serverUrl) {
        try {
            const parsed = new URL(serverUrl);
            const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
            return `${protocol}//${parsed.host}/ws`;
        } catch {
            return "ws://localhost:8787/ws";
        }
    }

    _detectDevUser() {
        if (typeof window !== "undefined") {
            const hostname = window.location?.hostname || "";
            const isLocal = hostname === "" ||
                hostname === "localhost" ||
                hostname === "127.0.0.1" ||
                hostname === "::1" ||
                hostname === "[::1]" ||
                hostname === "0.0.0.0";
            if (!isLocal) {
                return null;
            }
            const params = new URLSearchParams(window.location.search);
            const devFromUrl = params.get("dev_user");
            if (devFromUrl) return devFromUrl;

            // Сессионное сохранение выбранного dev-пользователя для этой вкладки
            try {
                const devFromSession = sessionStorage.getItem("tictactoe_dev_user");
                if (devFromSession) return devFromSession;
            } catch {}
        }
        return "dev_user_1";
    }

    _detectLaunchParams() {
        if (typeof window !== "undefined") {
            const search = window.location.search;
            if (search && search.includes("vk_user_id=")) {
                return search.startsWith("?") ? search.slice(1) : search;
            }
        }
        return null;
    }

    // Удобный метод подписки в стиле client.on('event', callback)
    on(eventType, callback) {
        const handler = event => callback(event.detail);
        this.addEventListener(eventType, handler);
        return () => this.removeEventListener(eventType, handler);
    }

    _emit(eventType, detail = {}) {
        this.dispatchEvent(new CustomEvent(eventType, { detail }));
    }

    _setState(newState, detail = {}) {
        this.state = newState;
        this._emit("state_change", { state: newState, ...detail });
    }

    // --- Авторизация ---

    async authenticate(overrideData = null) {
        this._setState("authenticating");

        const authPayload = {};
        if (overrideData) {
            Object.assign(authPayload, overrideData);
        } else if (this.launchParams) {
            authPayload.launchParams = this.launchParams;
        } else if (this.devUser) {
            authPayload.devUser = this.devUser;
        } else {
            throw new Error("Missing authentication credentials: no launch parameters or dev user available");
        }

        try {
            const response = await fetch(`${this.serverUrl}/api/auth`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(authPayload)
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            this.token = data.token;
            this.userId = data.userId;

            this._emit("authenticated", { userId: this.userId, token: this.token, dev: !!data.dev });
            return data;
        } catch (error) {
            this._setState("error", { error: error.message });
            this._emit("error", { message: `Ошибка авторизации: ${error.message}`, error });
            throw error;
        }
    }

    // --- Поиск соперника (Matchmaker DO) ---

    async startSearch(boardSize = 3, profile = {}) {
        if (this.state === "searching") {
            return;
        }

        if (!this.token) {
            await this.authenticate();
        }

        this._closeSocket();
        this._setState("searching", { boardSize });

        const queueUrl = `${this.wsUrl}?token=${encodeURIComponent(this.token)}`;
        const socket = new WebSocket(queueUrl);
        this._socket = socket;

        socket.onopen = () => {
            this._startHeartbeat();
        };

        socket.onmessage = event => {
            this._handleQueueMessage(event.data, boardSize, profile);
        };

        socket.onerror = error => {
            this._emit("error", { message: "Ошибка соединения с сервером поиска", error });
        };

        socket.onclose = event => {
            this._stopHeartbeat();
            if (this.state === "searching") {
                this._setState("idle");
                this._emit("close", { code: event.code, reason: event.reason });
            }
        };
    }

    _handleQueueMessage(rawData, boardSize, profile) {
        let msg;
        try {
            msg = JSON.parse(rawData);
        } catch {
            return;
        }

        switch (msg.type) {
            case "auth_ok":
                // После подтверждения входа отправляем команду постановки в очередь
                if (this._socket && this._socket.readyState === WebSocket.OPEN) {
                    this._socket.send(JSON.stringify({
                        type: "find_match",
                        boardSize,
                        profile
                    }));
                }
                break;

            case "searching":
                this._emit("searching", { boardSize: msg.boardSize });
                break;

            case "search_canceled":
                this._setState("idle");
                this._emit("search_canceled");
                break;

            case "match_start":
                this._stopHeartbeat();
                this._activeMatchInfo = msg;
                this.currentMatchId = msg.matchId;
                this.role = msg.role;
                this.seq = 0;

                this._emit("match_start", msg);

                // Сохраняем в sessionStorage для защиты от перезагрузки страницы
                try {
                    sessionStorage.setItem("tictactoe_active_match", JSON.stringify({
                        matchId: msg.matchId,
                        boardSize: msg.boardSize,
                        role: msg.role,
                        devUser: this.devUser,
                        launchParams: this.launchParams
                    }));
                } catch {}

                // Автоматически подключаемся к комнате партии (Match DO)
                this.connectToMatch(msg.matchId);
                break;

            case "error":
                this._setState("error", { message: msg.message });
                this._emit("error", { message: msg.message });
                break;
        }
    }

    cancelSearch() {
        if (this._socket && this._socket.readyState === WebSocket.OPEN) {
            try {
                this._socket.send(JSON.stringify({ type: "cancel_search" }));
            } catch {}
        }
        this._closeSocket();
        this._setState("idle");
        this._emit("search_canceled");
    }

    // --- Игровая комната партии (Match DO) ---

    async connectToMatch(matchId) {
        if (!this.token) {
            await this.authenticate();
        }

        this._closeSocket();
        this._setState("connecting", { matchId });

        const matchUrl = `${this.wsUrl}?token=${encodeURIComponent(this.token)}&matchId=${encodeURIComponent(matchId)}`;
        const socket = new WebSocket(matchUrl);
        this._socket = socket;

        socket.onopen = () => {
            this._startHeartbeat();
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
            }
            this._reconnectAttempts = 0;
        };

        socket.onmessage = event => {
            this._handleMatchMessage(event.data);
        };

        socket.onerror = error => {
            this._emit("error", { message: "Ошибка соединения с игровой комнатой", error });
        };

        socket.onclose = event => {
            this._stopHeartbeat();
            if (this.state === "active" || this.state === "connecting" || this.state === "paused") {
                this._setState("paused");
                this._emit("connection_lost", { matchId });

                if (this.currentMatchId && this.state !== "completed") {
                    this._scheduleAutoReconnect(matchId);
                }
            }
        };
    }

    _scheduleAutoReconnect(matchId) {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
        if (this._reconnectAttempts > 8) return;

        this._reconnectTimer = setTimeout(async () => {
            if (this.state === "completed" || !this.currentMatchId) return;
            try {
                await this.connectToMatch(matchId);
                this._reconnectAttempts = 0;
            } catch {
                this._scheduleAutoReconnect(matchId);
            }
        }, 1500);
    }

    _handleMatchMessage(rawData) {
        let msg;
        try {
            msg = JSON.parse(rawData);
        } catch {
            return;
        }

        switch (msg.type) {
            case "match_snapshot":
                this.currentMatchId = msg.matchId;
                this.role = msg.role;
                this.seq = msg.seq || 0;
                this._setState(msg.status === "paused" ? "paused" : "active");
                this._emit("snapshot", msg);
                break;

            case "move_applied":
                this.seq = Math.max(this.seq, msg.seq || 0);
                this._emit("move_applied", msg);
                break;

            case "invalid_move":
                this._emit("invalid_move", msg);
                break;

            case "opponent_disconnected":
                this._setState("paused");
                this._emit("opponent_disconnected", msg);
                break;

            case "opponent_reconnected":
                this._setState("active");
                this._emit("opponent_reconnected", msg);
                break;

            case "match_ended":
                this._setState("completed", { winner: msg.winner, reason: msg.reason });
                this._clearActiveMatchStorage();
                this._emit("match_ended", msg);
                break;

            case "heartbeat_ack":
                // Подтверждение активности соединения
                break;

            case "error":
                this._emit("error", { message: msg.message });
                break;
        }
    }

    makeMove(index) {
        if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
            throw new Error("Нет активного соединения с сервером матча");
        }
        if (this.state !== "active") {
            throw new Error(`Нельзя совершить ход в состоянии: ${this.state}`);
        }

        this.seq += 1;
        this._socket.send(JSON.stringify({
            type: "make_move",
            index,
            seq: this.seq
        }));
        return this.seq;
    }

    // --- Восстановление сессии (Reconnect) ---

    async checkAndRestoreSession() {
        let savedMatch;
        try {
            const raw = sessionStorage.getItem("tictactoe_active_match");
            if (raw) savedMatch = JSON.parse(raw);
        } catch {}

        if (!savedMatch || !savedMatch.matchId) {
            return false;
        }

        try {
            if (savedMatch.devUser) {
                this.devUser = savedMatch.devUser;
            }
            if (savedMatch.launchParams) {
                this.launchParams = savedMatch.launchParams;
            }
            await this.authenticate();
            await this.connectToMatch(savedMatch.matchId);
            return true;
        } catch (e) {
            this._clearActiveMatchStorage();
            return false;
        }
    }

    _clearActiveMatchStorage() {
        try {
            sessionStorage.removeItem("tictactoe_active_match");
        } catch {}
    }

    // --- Вспомогательные сервисы (Heartbeat и Socket) ---

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatInterval = setInterval(() => {
            if (this._socket && this._socket.readyState === WebSocket.OPEN) {
                try {
                    this._socket.send(JSON.stringify({ type: "heartbeat" }));
                } catch {}
            }
        }, 15000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    _closeSocket() {
        this._stopHeartbeat();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._reconnectAttempts = 0;
        if (this._socket) {
            try {
                this._socket.onopen = null;
                this._socket.onmessage = null;
                this._socket.onerror = null;
                this._socket.onclose = null;
                this._socket.close();
            } catch {}
            this._socket = null;
        }
    }

    dispose() {
        this._clearActiveMatchStorage();
        this._closeSocket();
        this._setState("idle");
    }
}
