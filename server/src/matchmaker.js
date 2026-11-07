/**
 * Matchmaker Durable Object — единый координатор очереди случайного подбора игроков (FIFO).
 * Обеспечивает атомарный подбор пары с одинаковым размером поля и инициирует создание Match DO.
 */

const VALID_BOARD_SIZES = new Set([3, 4, 5]);
const DEFAULT_TURN_DEADLINE_MS = 30_000;

export class Matchmaker {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.sockets = new Map(); // userId -> WebSocket

        // Инициализация таблицы очереди ожидания в SQLite
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS waiting_queue (
                user_id TEXT PRIMARY KEY,
                board_size INTEGER NOT NULL,
                user_name TEXT,
                user_avatar TEXT,
                joined_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL
            )
        `);
        this.ctx.storage.sql.exec(
            "CREATE INDEX IF NOT EXISTS idx_waiting_size_time ON waiting_queue(board_size, joined_at)"
        );
    }

    async fetch(request) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        const userId = request.headers.get("X-User-Id");
        if (!userId) {
            return new Response("Unauthorized", { status: 401 });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        server.accept();

        // Защита от одновременных подключений одного пользователя
        if (this.sockets.has(userId)) {
            const oldSocket = this.sockets.get(userId);
            try {
                oldSocket.close(4009, "Session replaced");
            } catch {}
        }

        this.sockets.set(userId, server);

        server.addEventListener("message", event => this.onMessage(userId, event));
        server.addEventListener("close", () => this.onSocketClose(userId));
        server.addEventListener("error", () => this.onSocketClose(userId));

        server.send(JSON.stringify({ type: "auth_ok", userId }));

        return new Response(null, {
            status: 101,
            webSocket: client
        });
    }

    async onMessage(userId, event) {
        if (typeof event.data !== "string") return;
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return this.sendToUser(userId, { type: "error", message: "Invalid JSON" });
        }

        if (!message || typeof message.type !== "string") {
            return this.sendToUser(userId, { type: "error", message: "Malformed message" });
        }

        const now = Date.now();

        switch (message.type) {
            case "find_match":
                await this.handleFindMatch(userId, message, now);
                break;
            case "cancel_search":
                this.handleCancelSearch(userId);
                break;
            case "heartbeat":
                this.handleHeartbeat(userId, now);
                break;
            default:
                this.sendToUser(userId, { type: "error", message: `Unknown message type: ${message.type}` });
        }
    }

    async handleFindMatch(userId, message, now) {
        const boardSize = Number.isInteger(message.boardSize) && VALID_BOARD_SIZES.has(message.boardSize)
            ? message.boardSize
            : 3;

        const userName = typeof message.profile?.name === "string" ? message.profile.name : `Игрок ${userId.slice(-4)}`;
        const userAvatar = typeof message.profile?.avatar === "string" ? message.profile.avatar : null;

        // Проверяем: не находится ли пользователь уже в очереди
        const existing = this.ctx.storage.sql.exec(
            "SELECT user_id, board_size FROM waiting_queue WHERE user_id = ?",
            userId
        ).toArray()[0];

        if (existing) {
            // Если уже в очереди с тем же размером поля — идемпотентно подтверждаем статус
            if (existing.board_size === boardSize) {
                this.ctx.storage.sql.exec(
                    "UPDATE waiting_queue SET last_seen = ? WHERE user_id = ?",
                    now,
                    userId
                );
                return this.sendToUser(userId, { type: "searching", boardSize });
            }
            // Если сменил размер — обновляем
            this.ctx.storage.sql.exec(
                "UPDATE waiting_queue SET board_size = ?, last_seen = ? WHERE user_id = ?",
                boardSize,
                now,
                userId
            );
        }

        // Поиск подходящего соперника с тем же board_size по FIFO
        let opponent = null;
        while (!opponent) {
            const candidates = this.ctx.storage.sql.exec(
                "SELECT * FROM waiting_queue WHERE board_size = ? AND user_id != ? ORDER BY joined_at ASC LIMIT 5",
                boardSize,
                userId
            ).toArray();

            if (candidates.length === 0) {
                break;
            }

            for (const candidate of candidates) {
                const opponentSocket = this.sockets.get(candidate.user_id);
                if (opponentSocket && opponentSocket.readyState === 1) {
                    opponent = candidate;
                    break;
                } else {
                    // Удаляем мертвое соединение из очереди
                    this.ctx.storage.sql.exec(
                        "DELETE FROM waiting_queue WHERE user_id = ?",
                        candidate.user_id
                    );
                }
            }
        }

        // Если соперник не найден — встаем в очередь
        if (!opponent) {
            this.ctx.storage.sql.exec(`
                INSERT INTO waiting_queue (user_id, board_size, user_name, user_avatar, joined_at, last_seen)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET board_size = excluded.board_size, last_seen = excluded.last_seen
            `, userId, boardSize, userName, userAvatar, now, now);

            return this.sendToUser(userId, { type: "searching", boardSize });
        }

        // Соперник найден! Атомарно удаляем обоих из очереди ожидания
        this.ctx.storage.sql.exec(
            "DELETE FROM waiting_queue WHERE user_id IN (?, ?)",
            userId,
            opponent.user_id
        );

        // Случайный жребий 50/50: кто играет крестиками (X), кто ноликами (O)
        const isUserX = Math.random() < 0.5;
        const playerX = isUserX
            ? { id: userId, name: userName, avatar: userAvatar }
            : { id: opponent.user_id, name: opponent.user_name, avatar: opponent.user_avatar };

        const playerO = isUserX
            ? { id: opponent.user_id, name: opponent.user_name, avatar: opponent.user_avatar }
            : { id: userId, name: userName, avatar: userAvatar };

        const matchId = crypto.randomUUID();

        // Инициализируем отдельный Match Durable Object для этой партии
        if (this.env?.MATCH) {
            try {
                const matchDO = this.env.MATCH.get(this.env.MATCH.idFromName(matchId));
                await matchDO.fetch(new Request("https://internal/init", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        matchId,
                        boardSize,
                        playerX,
                        playerO
                    })
                }));
            } catch (initErr) {
                console.error("Match DO initialization error:", initErr);
            }
        }

        // Уведомляем игрока X
        this.sendToUser(playerX.id, {
            type: "match_start",
            matchId,
            role: "X",
            boardSize,
            turn: "X",
            turnDeadlineMs: DEFAULT_TURN_DEADLINE_MS,
            opponent: {
                id: playerO.id,
                name: playerO.name,
                avatar: playerO.avatar
            }
        });

        // Уведомляем игрока O
        this.sendToUser(playerO.id, {
            type: "match_start",
            matchId,
            role: "O",
            boardSize,
            turn: "X",
            turnDeadlineMs: DEFAULT_TURN_DEADLINE_MS,
            opponent: {
                id: playerX.id,
                name: playerX.name,
                avatar: playerX.avatar
            }
        });
    }

    handleCancelSearch(userId) {
        this.ctx.storage.sql.exec(
            "DELETE FROM waiting_queue WHERE user_id = ?",
            userId
        );
        this.sendToUser(userId, { type: "search_canceled" });
    }

    handleHeartbeat(userId, now) {
        this.ctx.storage.sql.exec(
            "UPDATE waiting_queue SET last_seen = ? WHERE user_id = ?",
            now,
            userId
        );
        this.sendToUser(userId, { type: "heartbeat_ack" });
    }

    onSocketClose(userId) {
        this.sockets.delete(userId);
        this.ctx.storage.sql.exec(
            "DELETE FROM waiting_queue WHERE user_id = ?",
            userId
        );
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
}
