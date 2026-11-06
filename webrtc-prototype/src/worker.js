import { DurableObject } from "cloudflare:workers";

const MAX_SIGNAL_BYTES = 64 * 1024;
const WAITING_STALE_MS = 90_000;
const MATCH_STALE_MS = 90_000;
const MATCH_SETUP_TIMEOUT_MS = 35_000;
const OPEN = 1;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/ws") {
            if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket upgrade", { status: 426 });
            }
            const id = env.MATCHMAKER.idFromName("global-queue");
            return env.MATCHMAKER.get(id).fetch(request);
        }

        return env.ASSETS.fetch(request);
    }
};

export class Matchmaker extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sockets = new Map();
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS waiting (
                client_id TEXT PRIMARY KEY,
                joined_at INTEGER NOT NULL,
                last_seen INTEGER NOT NULL
            )
        `);
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS matches (
                match_id TEXT PRIMARY KEY,
                player_a TEXT NOT NULL,
                player_b TEXT NOT NULL,
                ready_a INTEGER NOT NULL DEFAULT 0,
                ready_b INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_seen_a INTEGER NOT NULL,
                last_seen_b INTEGER NOT NULL
            )
        `);
        this.ctx.storage.sql.exec(
            "CREATE INDEX IF NOT EXISTS matches_players ON matches(player_a, player_b)"
        );
    }

    fetch(request) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const clientId = crypto.randomUUID();

        this.cleanupStale(Date.now());
        server.accept();
        this.sockets.set(clientId, server);
        server.addEventListener("message", event => this.handleSocketMessage(clientId, event));
        server.addEventListener("close", () => this.handleSocketClosed(clientId));
        server.addEventListener("error", () => this.handleSocketClosed(clientId));
        this.send(clientId, { type: "welcome", clientId });

        return new Response(null, {
            status: 101,
            webSocket: client
        });
    }

    send(clientId, message) {
        const socket = this.sockets.get(clientId);
        if (!socket || socket.readyState !== OPEN) return false;
        try {
            socket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error(`WebSocket send failed for ${clientId}:`, error);
            socket.close(1011, "Message delivery failed");
            return false;
        }
    }

    handleSocketMessage(clientId, event) {
        if (typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).byteLength > MAX_SIGNAL_BYTES) {
            this.send(clientId, {
                type: "error",
                message: "Сообщение сигнализации превышает лимит или имеет неверный формат"
            });
            return;
        }

        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            this.send(clientId, { type: "error", message: "Некорректный JSON" });
            return;
        }

        if (!message || typeof message !== "object" || typeof message.type !== "string") {
            this.send(clientId, { type: "error", message: "Некорректный формат сообщения" });
            return;
        }

        const now = Date.now();
        this.cleanupStale(now);

        switch (message.type) {
            case "search":
                this.search(clientId, now);
                break;
            case "ready":
                this.markReady(clientId, message.matchId, now);
                break;
            case "signal":
                this.relaySignal(clientId, message);
                break;
            case "cancel":
                this.cancel(clientId, message.matchId);
                break;
            case "heartbeat":
                this.refreshHeartbeat(clientId, now);
                break;
            default:
                this.send(clientId, { type: "error", message: "Неизвестный тип сообщения" });
        }
    }

    cleanupStale(now) {
        const waiting = this.ctx.storage.sql.exec(
            "SELECT client_id, last_seen FROM waiting"
        ).toArray();
        for (const row of waiting) {
            const socket = this.sockets.get(row.client_id);
            if (!socket || socket.readyState !== OPEN ||
                now - row.last_seen > WAITING_STALE_MS) {
                this.ctx.storage.sql.exec(
                    "DELETE FROM waiting WHERE client_id = ?",
                    row.client_id
                );
            }
        }

        const matches = this.ctx.storage.sql.exec(
            "SELECT * FROM matches"
        ).toArray();
        for (const match of matches) {
            const pendingExpired = match.state === "pending" &&
                now - match.created_at > MATCH_SETUP_TIMEOUT_MS;
            const playerAStale = !this.isLive(match.player_a) ||
                now - match.last_seen_a > MATCH_STALE_MS;
            const playerBStale = !this.isLive(match.player_b) ||
                now - match.last_seen_b > MATCH_STALE_MS;
            if (pendingExpired || playerAStale || playerBStale) {
                this.ctx.storage.sql.exec(
                    "DELETE FROM matches WHERE match_id = ?",
                    match.match_id
                );
                const reason = pendingExpired ? "match-timeout" : "peer-left";
                if (!playerAStale) this.send(match.player_a, { type: reason });
                if (!playerBStale) this.send(match.player_b, { type: reason });
            }
        }
    }

    isLive(clientId) {
        const socket = this.sockets.get(clientId);
        return Boolean(socket && socket.readyState === OPEN);
    }

    findMatch(clientId) {
        return this.ctx.storage.sql.exec(
            "SELECT * FROM matches WHERE player_a = ? OR player_b = ? LIMIT 1",
            clientId,
            clientId
        ).toArray()[0] ?? null;
    }

    search(clientId, now) {
        if (!this.isLive(clientId)) return;
        if (this.findMatch(clientId)) {
            this.send(clientId, { type: "error", message: "Вы уже участвуете в паре" });
            return;
        }

        const alreadyWaiting = this.ctx.storage.sql.exec(
            "SELECT client_id FROM waiting WHERE client_id = ?",
            clientId
        ).toArray()[0];
        if (alreadyWaiting) {
            this.ctx.storage.sql.exec(
                "UPDATE waiting SET last_seen = ? WHERE client_id = ?",
                now,
                clientId
            );
            this.send(clientId, { type: "searching" });
            return;
        }

        const candidates = this.ctx.storage.sql.exec(
            "SELECT client_id FROM waiting WHERE client_id != ? ORDER BY joined_at ASC, client_id ASC",
            clientId
        ).toArray();
        const opponent = candidates.find(row => this.isLive(row.client_id));

        if (!opponent) {
            this.ctx.storage.sql.exec(
                "INSERT INTO waiting (client_id, joined_at, last_seen) VALUES (?, ?, ?)",
                clientId,
                now,
                now
            );
            this.send(clientId, { type: "searching" });
            return;
        }

        const playerA = opponent.client_id;
        const playerB = clientId;
        const matchId = crypto.randomUUID();
        this.ctx.storage.sql.exec(
            "DELETE FROM waiting WHERE client_id = ?",
            playerA
        );
        this.ctx.storage.sql.exec(
            "INSERT INTO matches (match_id, player_a, player_b, state, created_at, last_seen_a, last_seen_b) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
            matchId,
            playerA,
            playerB,
            now,
            now,
            now
        );

        const deliveredToA = this.send(playerA, {
            type: "match-found",
            matchId,
            peerId: playerB,
            initiator: true
        });
        const deliveredToB = this.send(playerB, {
            type: "match-found",
            matchId,
            peerId: playerA,
            initiator: false
        });
        if (!deliveredToA || !deliveredToB) {
            this.ctx.storage.sql.exec(
                "DELETE FROM matches WHERE match_id = ?",
                matchId
            );
            if (deliveredToA) this.send(playerA, { type: "match-timeout" });
            if (deliveredToB) this.send(playerB, { type: "match-timeout" });
        }
    }

    markReady(clientId, matchId, now) {
        if (typeof matchId !== "string") {
            this.send(clientId, { type: "error", message: "Не указан ID пары" });
            return;
        }
        const match = this.findMatch(clientId);
        if (!match || match.match_id !== matchId || match.state !== "pending") {
            this.send(clientId, { type: "error", message: "Пара уже недействительна" });
            return;
        }

        const isPlayerA = match.player_a === clientId;
        this.ctx.storage.sql.exec(
            isPlayerA
                ? "UPDATE matches SET ready_a = 1, last_seen_a = ? WHERE match_id = ?"
                : "UPDATE matches SET ready_b = 1, last_seen_b = ? WHERE match_id = ?",
            now,
            matchId
        );
        const updated = this.ctx.storage.sql.exec(
            "SELECT * FROM matches WHERE match_id = ?",
            matchId
        ).toArray()[0];
        if (!updated || !updated.ready_a || !updated.ready_b) return;

        this.ctx.storage.sql.exec(
            "UPDATE matches SET state = 'active' WHERE match_id = ?",
            matchId
        );
        this.send(updated.player_a, {
            type: "match-start",
            matchId,
            peerId: updated.player_b,
            initiator: true
        });
        this.send(updated.player_b, {
            type: "match-start",
            matchId,
            peerId: updated.player_a,
            initiator: false
        });
    }

    relaySignal(clientId, message) {
        const match = this.findMatch(clientId);
        if (!match || match.match_id !== message.matchId || match.state !== "active") {
            this.send(clientId, { type: "error", message: "Сигнализация для этой пары недоступна" });
            return;
        }
        if (!["offer", "answer", "ice"].includes(message.signalType) ||
            typeof message.signalId !== "string" || message.signalId.length > 100 ||
            !message.payload || typeof message.payload !== "object") {
            this.send(clientId, { type: "error", message: "Некорректные данные WebRTC-сигнализации" });
            return;
        }

        const targetId = match.player_a === clientId ? match.player_b : match.player_a;
        const delivered = this.send(targetId, {
            type: "signal",
            matchId: match.match_id,
            signalId: message.signalId,
            signalType: message.signalType,
            ...(message.signalType === "ice"
                ? { candidate: message.payload }
                : { description: message.payload })
        });
        this.send(clientId, {
            type: "signal-ack",
            matchId: match.match_id,
            signalId: message.signalId,
            signalType: message.signalType,
            delivered,
            ...(delivered ? {} : { reason: "recipient-websocket-unavailable" })
        });
    }

    refreshHeartbeat(clientId, now) {
        this.ctx.storage.sql.exec(
            "UPDATE waiting SET last_seen = ? WHERE client_id = ?",
            now,
            clientId
        );
        const match = this.findMatch(clientId);
        if (!match) return;
        this.ctx.storage.sql.exec(
            match.player_a === clientId
                ? "UPDATE matches SET last_seen_a = ? WHERE match_id = ?"
                : "UPDATE matches SET last_seen_b = ? WHERE match_id = ?",
            now,
            match.match_id
        );
    }

    cancel(clientId, matchId) {
        this.ctx.storage.sql.exec(
            "DELETE FROM waiting WHERE client_id = ?",
            clientId
        );
        const match = this.findMatch(clientId);
        if (match && (!matchId || match.match_id === matchId)) {
            this.ctx.storage.sql.exec(
                "DELETE FROM matches WHERE match_id = ?",
                match.match_id
            );
            const peerId = match.player_a === clientId
                ? match.player_b
                : match.player_a;
            this.send(peerId, { type: "peer-left" });
        }
        this.send(clientId, { type: "cancelled" });
    }

    handleSocketClosed(clientId) {
        const socket = this.sockets.get(clientId);
        this.sockets.delete(clientId);
        this.ctx.storage.sql.exec(
            "DELETE FROM waiting WHERE client_id = ?",
            clientId
        );
        const match = this.findMatch(clientId);
        if (match) {
            this.ctx.storage.sql.exec(
                "DELETE FROM matches WHERE match_id = ?",
                match.match_id
            );
            const peerId = match.player_a === clientId
                ? match.player_b
                : match.player_a;
            this.send(peerId, { type: "peer-left" });
        }
        if (socket && socket.readyState === OPEN) {
            socket.close(1000, "Connection closed");
        }
    }
}
