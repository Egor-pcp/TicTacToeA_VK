/**
 * Match Durable Object — отдельный сессионный инстанс на каждую игровую партию.
 * Управляет состоянием доски, валидацией ходов, тайм-аутами, reconnect и записью в D1.
 */

import { evaluateBoard, validateMove } from "./game-rules.js";

const DEFAULT_TURN_TIMEOUT_MS = 30_000;
const DEFAULT_GRACE_PERIOD_MS = 15_000;

export class Match {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;

        // Внутреннее состояние партии
        this.matchId = null;
        this.boardSize = 3;
        this.board = [];
        this.turn = "X";
        this.status = "idle"; // 'idle' | 'active' | 'paused' | 'completed'
        this.seq = 0;
        this.turnDeadline = 0;
        this.players = { X: null, O: null };
        this.sockets = new Map(); // userId -> WebSocket
        this.disconnectedUser = null;
        this.disconnectExpiresAt = 0;
        this.finalResult = null;
        this.startedAt = 0;
        this.movesHistory = [];
        this.d1Saved = false;
        this.rematchStatus = "unavailable";
        this.rematchVotes = new Set();
        this.rematchMatchId = null;
    }

    async fetch(request) {
        const url = new URL(request.url);

        // 1. Внутренняя инициализация комнаты из Matchmaker DO
        if (url.pathname === "/init" && request.method === "POST") {
            const data = await request.json();
            return this.handleInit(data);
        }
        if (url.pathname === "/abort-init" && request.method === "POST") {
            return this.handleAbortInit();
        }

        // 2. Подключение игрока по WebSocket к этой комнате
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            return this.handleWebSocket(request);
        }

        return new Response("Not Found", { status: 404 });
    }

    handleInit(data) {
        this.matchId = data.matchId;
        this.boardSize = data.boardSize || 3;
        this.board = Array(this.boardSize * this.boardSize).fill("");
        this.turn = "X";
        this.status = "active";
        this.seq = 0;
        this.startedAt = Date.now();
        this.turnDeadline = Date.now() + DEFAULT_TURN_TIMEOUT_MS;
        this.d1Saved = false;
        this.rematchStatus = "unavailable";
        this.rematchVotes.clear();
        this.rematchMatchId = null;

        this.players.X = {
            id: data.playerX.id,
            name: data.playerX.name || `Игрок ${data.playerX.id.slice(-4)}`,
            avatar: data.playerX.avatar || null
        };
        this.players.O = {
            id: data.playerO.id,
            name: data.playerO.name || `Игрок ${data.playerO.id.slice(-4)}`,
            avatar: data.playerO.avatar || null
        };

        this.scheduleTurnAlarm();

        return new Response(JSON.stringify({ ok: true, matchId: this.matchId }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    handleAbortInit() {
        if (this.status !== "active" || this.movesHistory.length > 0 || this.sockets.size > 0) {
            return new Response("Match is already in use", { status: 409 });
        }
        this.status = "aborted";
        try {
            this.ctx.storage.deleteAlarm();
        } catch {}
        return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    handleWebSocket(request) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const userId = request.headers.get("X-User-Id");

        // Защита: проверяем принадлежность пользователя к этому матчу
        if (!userId || (userId !== this.players.X?.id && userId !== this.players.O?.id)) {
            return new Response("Unauthorized for this match", { status: 403 });
        }

        server.accept();

        // Защита от параллельных сессий одного пользователя: закрываем старый сокет
        if (this.sockets.has(userId)) {
            const oldSocket = this.sockets.get(userId);
            try {
                oldSocket.close(4009, "Session replaced");
            } catch {}
        }

        this.sockets.set(userId, server);

        // Обработка восстановления связи (Reconnect)
        if (this.status === "paused" && this.disconnectedUser === userId) {
            this.handlePlayerReconnected(userId);
        }

        server.addEventListener("message", event => this.onMessage(userId, event));
        server.addEventListener("close", () => this.onSocketClose(userId, server));
        server.addEventListener("error", () => this.onSocketClose(userId, server));

        // Отправляем текущее состояние партии подключившемуся игроку
        server.send(JSON.stringify(this.buildSnapshot(userId)));
        if (this.status === "completed" && this.finalResult) {
            server.send(JSON.stringify(this.finalResult));
            if (this.rematchStatus === "pending") {
                server.send(JSON.stringify({
                    type: "rematch_status",
                    matchId: this.matchId,
                    acceptedUserIds: [...this.rematchVotes]
                }));
            } else if (this.rematchStatus === "declined") {
                server.send(JSON.stringify({ type: "rematch_declined", matchId: this.matchId }));
            } else if (this.rematchStatus === "started") {
                this.sendRematchStart(userId);
            } else if (this.rematchStatus === "failed") {
                server.send(JSON.stringify({ type: "rematch_error", matchId: this.matchId }));
            }
        }

        return new Response(null, { status: 101, webSocket: client });
    }

    buildSnapshot(userId) {
        const role = userId === this.players.X?.id ? "X" : "O";
        const opponentRole = role === "X" ? "O" : "X";
        const opponent = this.players[opponentRole];

        const snapshot = {
            type: "match_snapshot",
            matchId: this.matchId,
            role,
            turn: this.turn,
            seq: this.seq,
            board: this.board,
            boardSize: this.boardSize,
            opponent,
            remainingTurnMs: Math.max(0, this.turnDeadline - Date.now()),
            status: this.status
        };

        if (this.status === "paused") {
            snapshot.disconnectedUser = this.disconnectedUser;
            snapshot.gracePeriodMs = DEFAULT_GRACE_PERIOD_MS;
            snapshot.remainingGraceMs = this.disconnectExpiresAt ? Math.max(0, this.disconnectExpiresAt - Date.now()) : DEFAULT_GRACE_PERIOD_MS;
            snapshot.expiresAt = this.disconnectExpiresAt;
        }

        return snapshot;
    }

    onMessage(userId, event) {
        if (typeof event.data !== "string") return;
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        switch (msg.type) {
            case "make_move":
                this.handleMove(userId, msg);
                break;
            case "rematch_vote":
                this.handleRematchVote(userId, msg);
                break;
            case "reconnect_match":
                this.sendSnapshot(userId);
                break;
            case "heartbeat":
                this.sendToUser(userId, { type: "heartbeat_ack" });
                break;
        }
    }

    handleMove(userId, msg) {
        if (this.status !== "active") {
            return this.sendToUser(userId, {
                type: "invalid_move",
                seq: msg.seq,
                reason: "Match is not active"
            });
        }

        const role = userId === this.players.X?.id ? "X" : "O";
        if (this.turn !== role) {
            return this.sendToUser(userId, {
                type: "invalid_move",
                seq: msg.seq,
                reason: "Not your turn"
            });
        }

        // Защита от дублей ходов: проверяем sequence number
        if (typeof msg.seq === "number" && msg.seq <= this.seq) {
            return; // Идемпотентно игнорируем повторный пакет
        }

        const moveValidation = validateMove(this.board, this.boardSize, msg.index);
        if (!moveValidation.isValid) {
            return this.sendToUser(userId, {
                type: "invalid_move",
                seq: msg.seq,
                reason: moveValidation.reason
            });
        }

        // Проверяем тайм-аут хода
        if (Date.now() > this.turnDeadline) {
            const winnerRole = this.turn === "X" ? "O" : "X";
            return this.finishMatch(winnerRole, "timeout");
        }

        // Применяем ход
        this.board[msg.index] = role;
        this.seq = typeof msg.seq === "number" ? msg.seq : this.seq + 1;
        this.movesHistory.push({ role, index: msg.index, at: Date.now() });

        // Проверяем исход партии
        const evaluation = evaluateBoard(this.board, this.boardSize);
        if (evaluation.isOver) {
            return this.finishMatch(evaluation.winner, evaluation.winner === "draw" ? "draw" : "win", evaluation.line);
        }

        // Партия продолжается: передаем ход оппоненту
        this.turn = this.turn === "X" ? "O" : "X";
        this.turnDeadline = Date.now() + DEFAULT_TURN_TIMEOUT_MS;
        this.scheduleTurnAlarm();

        this.broadcast({
            type: "move_applied",
            seq: this.seq,
            index: msg.index,
            role,
            nextTurn: this.turn,
            turnDeadlineMs: DEFAULT_TURN_TIMEOUT_MS
        });
    }

    async handleRematchVote(userId, message) {
        if (this.status !== "completed" || ![this.players.X?.id, this.players.O?.id].includes(userId) ||
            (message.matchId && message.matchId !== this.matchId) || typeof message.accept !== "boolean") return;

        if (this.rematchStatus === "started") {
            return this.sendRematchStart(userId);
        }
        if (this.rematchStatus === "starting" || this.rematchStatus === "failed") return;
        if (this.rematchStatus === "declined") {
            return this.sendToUser(userId, { type: "rematch_declined", matchId: this.matchId });
        }

        if (!message.accept) {
            this.rematchStatus = "declined";
            this.rematchVotes.clear();
            this.broadcast({ type: "rematch_declined", matchId: this.matchId, declinedBy: userId });
            return;
        }

        this.rematchVotes.add(userId);
        this.rematchStatus = "pending";
        this.broadcast({
            type: "rematch_status",
            matchId: this.matchId,
            acceptedUserIds: [...this.rematchVotes]
        });

        if (this.rematchVotes.size === 2) {
            this.rematchStatus = "starting";
            await this.startRematch();
        }
    }

    async startRematch() {
        const playerX = this.players.O;
        const playerO = this.players.X;
        const matchId = crypto.randomUUID();
        let nextMatch = null;
        let initialized = false;

        try {
            const matchNamespace = this.env?.MATCH;
            const matchmakerNamespace = this.env?.MATCHMAKER;
            if (!matchNamespace || !matchmakerNamespace) throw new Error("Rematch services are unavailable");

            nextMatch = matchNamespace.get(matchNamespace.idFromName(matchId));
            const initResponse = await nextMatch.fetch(new Request("https://internal/init", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    matchId,
                    boardSize: this.boardSize,
                    playerX,
                    playerO
                })
            }));
            if (!initResponse.ok) throw new Error(`Rematch initialization failed: ${initResponse.status}`);
            initialized = true;

            const matchmaker = matchmakerNamespace.get(matchmakerNamespace.idFromName("global-queue"));
            const reservationResponse = await matchmaker.fetch(new Request("https://internal/register-rematch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    previousMatchId: this.matchId,
                    matchId,
                    boardSize: this.boardSize,
                    playerX,
                    playerO
                })
            }));
            if (!reservationResponse.ok) throw new Error(`Rematch reservation failed: ${reservationResponse.status}`);

            this.rematchMatchId = matchId;
            this.rematchStatus = "started";
            this.sendRematchStart(playerX.id);
            this.sendRematchStart(playerO.id);
        } catch (error) {
            console.error("Failed to start rematch:", error);
            if (initialized) {
                try {
                    await nextMatch.fetch(new Request("https://internal/abort-init", { method: "POST" }));
                } catch {}
            }
            this.rematchStatus = "failed";
            this.broadcast({ type: "rematch_error", matchId: this.matchId });
        }
    }

    sendRematchStart(userId) {
        if (!this.rematchMatchId) return;
        const role = userId === this.players.O.id ? "X" : "O";
        const opponent = role === "X" ? this.players.X : this.players.O;
        this.sendToUser(userId, {
            type: "rematch_start",
            previousMatchId: this.matchId,
            matchId: this.rematchMatchId,
            boardSize: this.boardSize,
            role,
            opponent
        });
    }

    onSocketClose(userId, socket) {
        if (socket && this.sockets.get(userId) !== socket) return;
        this.sockets.delete(userId);

        if (this.status === "active") {
            this.status = "paused";
            this.disconnectedUser = userId;
            this.disconnectExpiresAt = Date.now() + DEFAULT_GRACE_PERIOD_MS;
            const remainingUserId = userId === this.players.X?.id ? this.players.O?.id : this.players.X?.id;

            this.sendToUser(remainingUserId, {
                type: "opponent_disconnected",
                gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
                remainingGraceMs: DEFAULT_GRACE_PERIOD_MS,
                expiresAt: this.disconnectExpiresAt
            });

            // Взводим Alarm на завершение партии по неявке через grace period
            try {
                this.ctx.storage.setAlarm(this.disconnectExpiresAt);
            } catch {}
        }
    }

    handlePlayerReconnected(userId) {
        this.status = "active";
        this.disconnectedUser = null;
        this.disconnectExpiresAt = 0;
        this.turnDeadline = Date.now() + DEFAULT_TURN_TIMEOUT_MS;
        this.scheduleTurnAlarm();

        const opponentUserId = userId === this.players.X?.id ? this.players.O?.id : this.players.X?.id;
        this.sendToUser(opponentUserId, { type: "opponent_reconnected" });
    }

    sendSnapshot(userId) {
        this.sendToUser(userId, this.buildSnapshot(userId));
        if (this.status === "completed" && this.finalResult) {
            this.sendToUser(userId, this.finalResult);
        }
    }

    async alarm() {
        const now = Date.now();

        // 1. Если партия была на паузе из-за дисконнекта и grace period истек:
        if (this.status === "paused" && this.disconnectedUser) {
            const winnerRole = this.disconnectedUser === this.players.X?.id ? "O" : "X";
            return this.finishMatch(winnerRole, "abandoned");
        }

        // 2. Если партия активна и истек срок хода:
        if (this.status === "active" && now >= this.turnDeadline) {
            const winnerRole = this.turn === "X" ? "O" : "X";
            return this.finishMatch(winnerRole, "timeout");
        }
    }

    scheduleTurnAlarm() {
        try {
            this.ctx.storage.setAlarm(this.turnDeadline);
        } catch {}
    }

    async finishMatch(winner, reason = "win", winningLine = null) {
        if (this.status === "completed") return; // Защита от повторного завершения
        this.status = "completed";
        this.rematchStatus = "waiting";
        this.rematchVotes.clear();

        const winnerUserId = winner === "X" ? this.players.X?.id : winner === "O" ? this.players.O?.id : null;
        const durationMs = Date.now() - this.startedAt;

        const endMessage = {
            type: "match_ended",
            matchId: this.matchId,
            winner,
            reason,
            winningLine: winningLine || undefined,
            durationMs,
            board: this.board
        };
        this.finalResult = endMessage;

        // Идемпотентное сохранение в Cloudflare D1
        if (this.env?.DB && this.matchId && !this.d1Saved) {
            this.d1Saved = true;
            await this.saveResultToD1(winnerUserId, winner, reason, durationMs);
        }

        await this.releaseMatchmakerReservation();
        this.broadcast(endMessage);
    }

    async releaseMatchmakerReservation() {
        const namespace = this.env?.MATCHMAKER;
        if (!namespace || !this.matchId) return;

        try {
            const matchmaker = namespace.get(namespace.idFromName("global-queue"));
            await matchmaker.fetch(new Request("https://internal/match-ended", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ matchId: this.matchId })
            }));
        } catch (error) {
            console.error("Failed to release Matchmaker reservation:", error);
        }
    }

    async saveResultToD1(winnerUserId, winner, reason, durationMs) {
        try {
            const now = Date.now();
            const playerXId = this.players.X.id;
            const playerOId = this.players.O.id;

            // 0. Гарантируем наличие игроков в таблице users (для внешних ключей)
            await this.env.DB.prepare(`
                INSERT INTO users (vk_user_id, first_name, last_name, avatar_url, created_at, last_seen_at)
                VALUES (?, ?, '', ?, ?, ?)
                ON CONFLICT(vk_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
            `).bind(playerXId, this.players.X.name, this.players.X.avatar, now, now).run();

            await this.env.DB.prepare(`
                INSERT INTO users (vk_user_id, first_name, last_name, avatar_url, created_at, last_seen_at)
                VALUES (?, ?, '', ?, ?, ?)
                ON CONFLICT(vk_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
            `).bind(playerOId, this.players.O.name, this.players.O.avatar, now, now).run();

            // 1. Запись истории партии
            await this.env.DB.prepare(`
                INSERT INTO match_history (
                    match_id, board_size, player_x_id, player_o_id, winner_id, win_reason, moves_count, duration_ms, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(match_id) DO NOTHING
            `).bind(
                this.matchId,
                this.boardSize,
                playerXId,
                playerOId,
                winnerUserId,
                reason,
                this.movesHistory.length,
                durationMs,
                now
            ).run();

            // 2. Обновление рейтинга (leaderboards)
            const isDraw = winner === "draw";
            const xRatingDelta = isDraw ? 5 : winner === "X" ? 25 : -25;
            const oRatingDelta = isDraw ? 5 : winner === "O" ? 25 : -25;

            await this.updateUserStatsInD1(playerXId, winner === "X", isDraw, xRatingDelta, now, durationMs);
            await this.updateUserStatsInD1(playerOId, winner === "O", isDraw, oRatingDelta, now, durationMs);
        } catch (err) {
            console.error("Failed to save match result in D1:", err);
        }
    }

    async updateUserStatsInD1(userId, isWinner, isDraw, ratingDelta, now, durationMs) {
        try {
            await this.env.DB.prepare(`
                INSERT INTO leaderboards (vk_user_id, rating, games_played, wins, losses, draws, best_win_time_ms, updated_at)
                VALUES (?, ?, 1, ?, ?, ?, ?, ?)
                ON CONFLICT(vk_user_id) DO UPDATE SET
                    rating = MAX(0, leaderboards.rating + ?),
                    games_played = leaderboards.games_played + 1,
                    wins = leaderboards.wins + excluded.wins,
                    losses = leaderboards.losses + excluded.losses,
                    draws = leaderboards.draws + excluded.draws,
                    best_win_time_ms = CASE 
                        WHEN excluded.wins = 1 AND (leaderboards.best_win_time_ms IS NULL OR excluded.best_win_time_ms < leaderboards.best_win_time_ms)
                        THEN excluded.best_win_time_ms
                        ELSE leaderboards.best_win_time_ms
                    END,
                    updated_at = excluded.updated_at
            `).bind(
                userId,
                1000 + ratingDelta,
                isWinner ? 1 : 0,
                (!isWinner && !isDraw) ? 1 : 0,
                isDraw ? 1 : 0,
                isWinner ? durationMs : null,
                now,
                ratingDelta
            ).run();
        } catch (err) {
            console.error(`Failed to update leaderboards for ${userId}:`, err);
        }
    }

    sendToUser(userId, message) {
        const socket = this.sockets.get(userId);
        if (socket && socket.readyState === 1) {
            try {
                socket.send(JSON.stringify(message));
                return true;
            } catch {}
        }
        return false;
    }

    broadcast(message) {
        const payload = JSON.stringify(message);
        for (const socket of this.sockets.values()) {
            if (socket.readyState === 1) {
                try {
                    socket.send(payload);
                } catch {}
            }
        }
    }
}
