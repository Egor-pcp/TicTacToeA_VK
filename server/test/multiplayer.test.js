import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Matchmaker } from "../src/matchmaker.js";
import { Match } from "../src/match.js";

// --- Настройка Mock WebSocket & Response для Node.js среды ---

class MockWebSocket extends EventTarget {
    constructor() {
        super();
        this.readyState = 1; // 1 = OPEN, 3 = CLOSED
        this.peer = null;
        this.messages = [];
    }

    send(data) {
        if (this.readyState !== 1) return;
        if (this.peer && this.peer.readyState === 1) {
            this.peer.messages.push(data);
            queueMicrotask(() => {
                this.peer.dispatchEvent(new MessageEvent("message", { data }));
            });
        }
    }

    accept() {
        this.readyState = 1;
    }

    close(code = 1000, reason = "") {
        if (this.readyState === 3) return;
        this.readyState = 3;
        queueMicrotask(() => {
            this.dispatchEvent(new CloseEvent("close", { code, reason }));
            if (this.peer && this.peer.readyState !== 3) {
                this.peer.readyState = 3;
                this.peer.dispatchEvent(new CloseEvent("close", { code, reason }));
            }
        });
    }
}

class MockWebSocketPair {
    constructor() {
        const client = new MockWebSocket();
        const server = new MockWebSocket();
        client.peer = server;
        server.peer = client;
        return [client, server];
    }
}

// Устанавливаем глобальный WebSocketPair для Durable Objects
globalThis.WebSocketPair = MockWebSocketPair;

// Полифилл Response для поддержки status 101 (Switching Protocols)
const OriginalResponse = globalThis.Response;
class CloudflareTestResponse extends OriginalResponse {
    constructor(body, init) {
        if (init && init.status === 101) {
            super(null, { ...init, status: 200, statusText: "Switching Protocols" });
            Object.defineProperty(this, "status", { value: 101, writable: false });
            if (init.webSocket) {
                this.webSocket = init.webSocket;
            }
            return;
        }
        super(body, init);
    }
}
globalThis.Response = CloudflareTestResponse;

// --- Вспомогательные функции эмуляции Cloudflare DO Storage & D1 ---

function createMockDOStorage() {
    const memDb = new DatabaseSync(":memory:");
    let scheduledAlarm = null;

    return {
        sql: {
            exec(sql, ...params) {
                const trimmed = sql.trim();
                if (trimmed.toUpperCase().startsWith("SELECT")) {
                    const stmt = memDb.prepare(sql);
                    const rows = stmt.all(...params);
                    return { toArray: () => rows };
                }
                if (params.length > 0) {
                    const stmt = memDb.prepare(sql);
                    stmt.run(...params);
                } else {
                    memDb.exec(sql);
                }
                return { toArray: () => [] };
            }
        },
        setAlarm(timestamp) {
            scheduledAlarm = timestamp;
        },
        getAlarm() {
            return scheduledAlarm;
        }
    };
}

function createMockD1() {
    const d1Db = new DatabaseSync(":memory:");
    const schemaPath = path.resolve(import.meta.dirname, "../migrations/0001_initial.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    d1Db.exec(schemaSql);

    return {
        _db: d1Db,
        prepare(query) {
            let boundParams = [];
            return {
                bind(...params) {
                    boundParams = params;
                    return this;
                },
                async run() {
                    const stmt = d1Db.prepare(query);
                    const info = stmt.run(...boundParams);
                    return { success: true, meta: info };
                },
                async all() {
                    const stmt = d1Db.prepare(query);
                    const results = stmt.all(...boundParams);
                    return { results, success: true };
                }
            };
        }
    };
}

// Ожидание конкретного типа сообщения от WebSocket сокета с поддержкой буфера
function waitForMessage(socket, targetType, timeoutMs = 2000) {
    if (socket.messages && socket.messages.length > 0) {
        const idx = socket.messages.findIndex(m => {
            try {
                const data = JSON.parse(m);
                return !targetType || data.type === targetType;
            } catch {
                return false;
            }
        });
        if (idx !== -1) {
            const raw = socket.messages.splice(idx, 1)[0];
            return Promise.resolve(JSON.parse(raw));
        }
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.removeEventListener("message", onMsg);
            reject(new Error(`Timeout waiting for message type "${targetType}"`));
        }, timeoutMs);

        function onMsg(event) {
            try {
                const data = JSON.parse(event.data);
                if (!targetType || data.type === targetType) {
                    clearTimeout(timer);
                    socket.removeEventListener("message", onMsg);
                    if (socket.messages) {
                        const idx = socket.messages.indexOf(event.data);
                        if (idx !== -1) socket.messages.splice(idx, 1);
                    }
                    resolve(data);
                }
            } catch {}
        }

        socket.addEventListener("message", onMsg);
    });
}

// --- Тестовые наборы ---

describe("Серверный онлайн-мультиплеер TicTacToeA_VK", () => {
    let mockD1;
    let matchInstances;
    let mockEnv;
    let matchmaker;

    beforeEach(() => {
        mockD1 = createMockD1();
        matchInstances = new Map();

        mockEnv = {
            DB: mockD1,
            MATCH: {
                idFromName: name => name,
                get: id => {
                    if (!matchInstances.has(id)) {
                        const match = new Match({ storage: createMockDOStorage() }, mockEnv);
                        matchInstances.set(id, match);
                    }
                    return matchInstances.get(id);
                }
            },
            MATCHMAKER: {
                idFromName: () => "global-queue",
                get: () => matchmaker
            }
        };

        matchmaker = new Matchmaker({ storage: createMockDOStorage() }, mockEnv);
    });

    async function connectUserToMatchmaker(userId) {
        const req = new Request("https://example.com/ws", {
            headers: {
                Upgrade: "websocket",
                "X-User-Id": userId
            }
        });
        const res = await matchmaker.fetch(req);
        assert.equal(res.status, 101);
        const socket = res.webSocket;
        const authOk = await waitForMessage(socket, "auth_ok");
        assert.equal(authOk.userId, userId);
        return socket;
    }

    // 1. Подбор двух игроков (find_match)
    test("1. Два игрока вызывают find_match, находят друг друга и получают match_start", async () => {
        const client1 = await connectUserToMatchmaker("player_1");
        const client2 = await connectUserToMatchmaker("player_2");

        client1.send(JSON.stringify({
            type: "find_match",
            boardSize: 3,
            profile: { name: "Алиса", avatar: "avatar_1.png" }
        }));

        const searchMsg = await waitForMessage(client1, "searching");
        assert.equal(searchMsg.boardSize, 3);

        const startPromise1 = waitForMessage(client1, "match_start");
        const startPromise2 = waitForMessage(client2, "match_start");

        client2.send(JSON.stringify({
            type: "find_match",
            boardSize: 3,
            profile: { name: "Боб", avatar: "avatar_2.png" }
        }));

        const [start1, start2] = await Promise.all([startPromise1, startPromise2]);

        assert.equal(start1.matchId, start2.matchId);
        assert.equal(start1.boardSize, 3);
        assert.equal(start2.boardSize, 3);
        assert.equal(start1.turn, "X");
        assert.equal(start2.turn, "X");

        // Комплементарные роли X и O
        const roles = new Set([start1.role, start2.role]);
        assert.equal(roles.has("X"), true);
        assert.equal(roles.has("O"), true);

        // Проверяем корректную передачу профиля соперника
        assert.equal(start1.opponent.name, "Боб");
        assert.equal(start2.opponent.name, "Алиса");
    });

    // 2. Очередь с несколькими игроками (FIFO)
    test("2. Очередь с несколькими игроками соблюдает строгий FIFO порядок", async () => {
        const client1 = await connectUserToMatchmaker("player_fifo_1");
        const client2 = await connectUserToMatchmaker("player_fifo_2");
        const client3 = await connectUserToMatchmaker("player_fifo_3");

        client1.send(JSON.stringify({ type: "find_match", boardSize: 3, profile: { name: "Игрок 1" } }));
        await waitForMessage(client1, "searching");

        client2.send(JSON.stringify({ type: "find_match", boardSize: 3, profile: { name: "Игрок 2" } }));

        // Первые двое (1 и 2) должны сразу образовать пару
        const start1 = await waitForMessage(client1, "match_start");
        const start2 = await waitForMessage(client2, "match_start");
        assert.equal(start1.matchId, start2.matchId);

        // Игрок 3 встает в очередь после того, как 1 и 2 уже спарились
        client3.send(JSON.stringify({ type: "find_match", boardSize: 3, profile: { name: "Игрок 3" } }));
        const search3 = await waitForMessage(client3, "searching");
        assert.equal(search3.boardSize, 3);

        // Игрок 4 встает в очередь -> должен спариться именно с игроком 3
        const client4 = await connectUserToMatchmaker("player_fifo_4");
        const start3Promise = waitForMessage(client3, "match_start");
        const start4Promise = waitForMessage(client4, "match_start");

        client4.send(JSON.stringify({ type: "find_match", boardSize: 3, profile: { name: "Игрок 4" } }));

        const [start3, start4] = await Promise.all([start3Promise, start4Promise]);
        assert.equal(start3.matchId, start4.matchId);
        assert.notEqual(start3.matchId, start1.matchId);
    });

    // 3. Отмена поиска (cancel_search)
    test("3. cancel_search удаляет игрока из очереди и предотвращает матч", async () => {
        const client1 = await connectUserToMatchmaker("player_cancel_1");
        client1.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
        await waitForMessage(client1, "searching");

        // Отменяем поиск
        client1.send(JSON.stringify({ type: "cancel_search" }));
        const cancelMsg = await waitForMessage(client1, "search_canceled");
        assert.equal(cancelMsg.type, "search_canceled");

        // Теперь подключается второй игрок — матча не должно быть, он должен ждать
        const client2 = await connectUserToMatchmaker("player_cancel_2");
        client2.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
        const searchMsg2 = await waitForMessage(client2, "searching");
        assert.equal(searchMsg2.type, "searching");
    });

    // 4. Защита от дубликатов в очереди
    test("4. Повторный вызов find_match не дублирует пользователя в очереди", async () => {
        const client = await connectUserToMatchmaker("player_dup_1");

        client.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
        await waitForMessage(client, "searching");

        // Повторный запрос поиска с тем же размером поля
        client.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
        const searchMsg = await waitForMessage(client, "searching");
        assert.equal(searchMsg.type, "searching");

        // Проверяем состояние БД: ровно 1 запись для этого пользователя
        const rows = matchmaker.ctx.storage.sql.exec(
            "SELECT COUNT(*) as count FROM waiting_queue WHERE user_id = ?",
            "player_dup_1"
        ).toArray();
        assert.equal(rows[0].count, 1);
    });

    test("5. Смена размера заменяет запись очереди, а найденный игрок не ставится в очередь повторно", async () => {
        const client1 = await connectUserToMatchmaker("player_resize_1");
        client1.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
        await waitForMessage(client1, "searching");

        const matchStart1 = waitForMessage(client1, "match_start");
        client1.send(JSON.stringify({ type: "find_match", boardSize: 5 }));
        const resized = await waitForMessage(client1, "searching");
        assert.equal(resized.boardSize, 5);

        let queueRows = matchmaker.ctx.storage.sql.exec(
            "SELECT user_id, board_size FROM waiting_queue WHERE user_id = ?",
            "player_resize_1"
        ).toArray();
        assert.equal(queueRows.length, 1);
        assert.equal(queueRows[0].board_size, 5);

        const client2 = await connectUserToMatchmaker("player_resize_2");
        const matchStart2 = waitForMessage(client2, "match_start");
        client2.send(JSON.stringify({ type: "find_match", boardSize: 5 }));
        const [start1, start2] = await Promise.all([matchStart1, matchStart2]);
        assert.equal(start1.matchId, start2.matchId);
        assert.equal(start1.boardSize, 5);
        assert.equal(start2.boardSize, 5);

        // Имитация последнего resize-пакета, уже отправленного до match_start.
        client1.send(JSON.stringify({ type: "find_match", boardSize: 4 }));
        const alreadyMatched = await waitForMessage(client1, "match_already_started");
        assert.equal(alreadyMatched.matchId, start1.matchId);
        assert.equal(alreadyMatched.boardSize, 5);
        queueRows = matchmaker.ctx.storage.sql.exec(
            "SELECT user_id FROM waiting_queue WHERE user_id = ?",
            "player_resize_1"
        ).toArray();
        assert.equal(queueRows.length, 0);

        const client3 = await connectUserToMatchmaker("player_resize_3");
        client3.send(JSON.stringify({ type: "find_match", boardSize: 5 }));
        const waiting = await waitForMessage(client3, "searching");
        assert.equal(waiting.boardSize, 5);
        const activeQueueRows = matchmaker.ctx.storage.sql.exec(
            "SELECT user_id FROM waiting_queue WHERE board_size = ?",
            5
        ).toArray();
        assert.deepEqual(activeQueueRows.map(row => row.user_id), ["player_resize_3"]);

        await matchInstances.get(start1.matchId).finishMatch("draw", "draw");
        const releasedMatches = matchmaker.ctx.storage.sql.exec(
            "SELECT user_id, status FROM active_matches WHERE match_id = ?",
            start1.matchId
        ).toArray();
        assert.deepEqual(releasedMatches.map(row => row.status), ["completed", "completed"]);
        const searchAfterCompletion = waitForMessage(client1, "searching");
        client1.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
        assert.equal((await searchAfterCompletion).boardSize, 3);
    });

    // 6. Жребий X/O работает честно (проверка распределения 50/50)
    test("6. Жребий X/O честно распределяет роли 50/50 при создании матчей", async () => {
        let xCount = 0;
        const totalMatches = 40;

        for (let i = 0; i < totalMatches; i++) {
            const u1 = `prob_p1_${i}`;
            const u2 = `prob_p2_${i}`;
            const c1 = await connectUserToMatchmaker(u1);
            const c2 = await connectUserToMatchmaker(u2);

            const p1Start = waitForMessage(c1, "match_start");
            c1.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
            await waitForMessage(c1, "searching");

            c2.send(JSON.stringify({ type: "find_match", boardSize: 3 }));
            const start1 = await p1Start;

            if (start1.role === "X") {
                xCount++;
            }
        }

        // При 40 бросках честной монеты вероятность получить < 10 или > 30 cực kỳ мала (< 0.1%)
        assert.ok(xCount >= 10 && xCount <= 30, `Случайное распределение ролей в норме: X выпал ${xCount}/${totalMatches}`);
    });

    // Вспомогательная функция инициализации активного Match DO
    async function setupDirectMatch(boardSize = 3) {
        const matchId = `match_${Math.random().toString(36).slice(2, 9)}`;
        const matchDO = mockEnv.MATCH.get(matchId);

        await matchDO.fetch(new Request("https://internal/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                matchId,
                boardSize,
                playerX: { id: "user_x", name: "Игрок X", avatar: null },
                playerO: { id: "user_o", name: "Игрок O", avatar: null }
            })
        }));

        async function connectMatchSocket(userId) {
            const req = new Request(`https://example.com/ws?matchId=${matchId}`, {
                headers: {
                    Upgrade: "websocket",
                    "X-User-Id": userId
                }
            });
            const res = await matchDO.fetch(req);
            assert.equal(res.status, 101);
            const socket = res.webSocket;
            const snapshot = await waitForMessage(socket, "match_snapshot");
            assert.equal(snapshot.matchId, matchId);
            return { socket, snapshot };
        }

        const { socket: socketX, snapshot: snapX } = await connectMatchSocket("user_x");
        const { socket: socketO, snapshot: snapO } = await connectMatchSocket("user_o");

        return { matchDO, matchId, socketX, socketO, snapX, snapO };
    }

    // 6. Ход и победа X
    test("7. Ход и победа X: корректное завершение с winningLine и записью", async () => {
        const { matchDO, socketX, socketO } = await setupDirectMatch(3);

        const endPromiseX = waitForMessage(socketX, "match_ended");
        const endPromiseO = waitForMessage(socketO, "match_ended");

        // Ходы: X(0), O(3), X(1), O(4), X(2) -> Победа X по верхней строке [0, 1, 2]
        socketX.send(JSON.stringify({ type: "make_move", index: 0, seq: 1 }));
        await waitForMessage(socketX, "move_applied");

        socketO.send(JSON.stringify({ type: "make_move", index: 3, seq: 2 }));
        await waitForMessage(socketO, "move_applied");

        socketX.send(JSON.stringify({ type: "make_move", index: 1, seq: 3 }));
        await waitForMessage(socketX, "move_applied");

        socketO.send(JSON.stringify({ type: "make_move", index: 4, seq: 4 }));
        await waitForMessage(socketO, "move_applied");

        socketX.send(JSON.stringify({ type: "make_move", index: 2, seq: 5 }));

        const [endX, endO] = await Promise.all([endPromiseX, endPromiseO]);

        assert.equal(endX.winner, "X");
        assert.equal(endX.reason, "win");
        assert.deepEqual(endX.winningLine, [0, 1, 2]);
        assert.equal(endO.winner, "X");
        assert.equal(matchDO.status, "completed");
    });

    // 7. Ход и победа O
    test("8. Ход и победа O: корректное завершение", async () => {
        const { matchDO, socketX, socketO } = await setupDirectMatch(3);

        const endPromise = waitForMessage(socketO, "match_ended");

        // Ходы: X(0), O(3), X(1), O(4), X(6), O(5) -> Победа O по строке [3, 4, 5]
        socketX.send(JSON.stringify({ type: "make_move", index: 0, seq: 1 }));
        await waitForMessage(socketX, "move_applied");

        socketO.send(JSON.stringify({ type: "make_move", index: 3, seq: 2 }));
        await waitForMessage(socketO, "move_applied");

        socketX.send(JSON.stringify({ type: "make_move", index: 1, seq: 3 }));
        await waitForMessage(socketX, "move_applied");

        socketO.send(JSON.stringify({ type: "make_move", index: 4, seq: 4 }));
        await waitForMessage(socketO, "move_applied");

        socketX.send(JSON.stringify({ type: "make_move", index: 6, seq: 5 }));
        await waitForMessage(socketX, "move_applied");

        socketO.send(JSON.stringify({ type: "make_move", index: 5, seq: 6 }));

        const endO = await endPromise;
        assert.equal(endO.winner, "O");
        assert.equal(endO.reason, "win");
        assert.deepEqual(endO.winningLine, [3, 4, 5]);
    });

    // 8. Ничья (draw)
    test("9. Ничья: полное заполнение доски без победителя", async () => {
        const { matchDO, socketX, socketO } = await setupDirectMatch(3);

        const endPromise = waitForMessage(socketX, "match_ended");

        // Ничейная партия:
        // X: 0, 2, 3, 7, 8
        // O: 1, 4, 5, 6
        // Доска:
        // X O X
        // X O O
        // O X X
        const moves = [
            { s: socketX, idx: 0, seq: 1 },
            { s: socketO, idx: 1, seq: 2 },
            { s: socketX, idx: 2, seq: 3 },
            { s: socketO, idx: 4, seq: 4 },
            { s: socketX, idx: 3, seq: 5 },
            { s: socketO, idx: 5, seq: 6 },
            { s: socketX, idx: 7, seq: 7 },
            { s: socketO, idx: 6, seq: 8 }
        ];

        for (const m of moves) {
            m.s.send(JSON.stringify({ type: "make_move", index: m.idx, seq: m.seq }));
            await waitForMessage(m.s, "move_applied");
        }

        // Финальный ход X в клетку 8
        socketX.send(JSON.stringify({ type: "make_move", index: 8, seq: 9 }));

        const endResult = await endPromise;
        assert.equal(endResult.winner, "draw");
        assert.equal(endResult.reason, "draw");
        assert.equal(matchDO.status, "completed");
    });

    // 9. Отклонение некорректного хода (invalid_move)
    test("10. Некорректный ход (вне доски, в занятую клетку) отклоняется с invalid_move", async () => {
        const { socketX } = await setupDirectMatch(3);

        // Ход за пределы доски
        socketX.send(JSON.stringify({ type: "make_move", index: 99, seq: 1 }));
        const err1 = await waitForMessage(socketX, "invalid_move");
        assert.equal(err1.type, "invalid_move");
        assert.equal(err1.reason, "Move index out of board bounds");

        // Легитимный ход в клетку 0
        socketX.send(JSON.stringify({ type: "make_move", index: 0, seq: 2 }));
        await waitForMessage(socketX, "move_applied");

        // Попытка походить в уже занятую клетку 0
        socketX.send(JSON.stringify({ type: "make_move", index: 0, seq: 3 }));
        const err2 = await waitForMessage(socketX, "invalid_move");
        assert.equal(err2.type, "invalid_move");
    });

    // 10. Нарушение очередности ходов
    test("11. Ход не в свою очередь отклоняется сервером", async () => {
        const { socketO } = await setupDirectMatch(3);

        // Игрок O пытается походить первым (хотя первым ходит X)
        socketO.send(JSON.stringify({ type: "make_move", index: 0, seq: 1 }));
        const err = await waitForMessage(socketO, "invalid_move");
        assert.equal(err.type, "invalid_move");
        assert.equal(err.reason, "Not your turn");
    });

    // 11. Идемпотентность ходов (seq sequence numbers)
    test("12. Идемпотентность: повторный пакет с тем же seq не дублирует ход", async () => {
        const { matchDO, socketX } = await setupDirectMatch(3);

        socketX.send(JSON.stringify({ type: "make_move", index: 0, seq: 1 }));
        const applied = await waitForMessage(socketX, "move_applied");
        assert.equal(applied.index, 0);
        assert.equal(matchDO.board[0], "X");
        assert.equal(matchDO.turn, "O");

        // Повторный пакет с seq: 1 (сетевой дубль)
        socketX.send(JSON.stringify({ type: "make_move", index: 0, seq: 1 }));

        // Никаких изменений состояния не происходит
        assert.equal(matchDO.board[0], "X");
        assert.equal(matchDO.turn, "O");
    });

    // 12. Тайм-аут хода (Turn Timeout via Alarm)
    test("13. Тайм-аут хода: присуждение поражения при истечении времени", async () => {
        const { matchDO, socketX, socketO } = await setupDirectMatch(3);

        const endPromiseX = waitForMessage(socketX, "match_ended");
        const endPromiseO = waitForMessage(socketO, "match_ended");

        // Искусственно смещаем deadline хода в прошлое
        matchDO.turnDeadline = Date.now() - 1000;

        // Срабатывает Alarm Durable Object
        await matchDO.alarm();

        const [endX, endO] = await Promise.all([endPromiseX, endPromiseO]);
        assert.equal(endX.winner, "O"); // Ход был у X, значит победил O
        assert.equal(endX.reason, "timeout");
        assert.equal(endO.winner, "O");
        assert.equal(matchDO.status, "completed");
    });

    // 13. Временный дисконнект и reconnect_match
    test("14. Временный дисконнект и reconnect: отправка snapshot и восстановление партии", async () => {
        const { matchDO, matchId, socketX, socketO } = await setupDirectMatch(3);

        // Игрок X делает первый ход
        socketX.send(JSON.stringify({ type: "make_move", index: 4, seq: 1 }));
        await waitForMessage(socketX, "move_applied");

        const disconnectPromise = waitForMessage(socketX, "opponent_disconnected");

        // Игрок O теряет связь
        socketO.close();

        const disMsg = await disconnectPromise;
        assert.equal(disMsg.type, "opponent_disconnected");
        assert.equal(disMsg.gracePeriodMs, 15000);
        assert.equal(matchDO.status, "paused");

        // Игрок O восстанавливает подключение до истечения grace period
        const reconnectReq = new Request(`https://example.com/ws?matchId=${matchId}`, {
            headers: {
                Upgrade: "websocket",
                "X-User-Id": "user_o"
            }
        });
        const reconnectedRes = await matchDO.fetch(reconnectReq);
        const reconnectedSocket = reconnectedRes.webSocket;

        const snapshot = await waitForMessage(reconnectedSocket, "match_snapshot");
        assert.equal(snapshot.role, "O");
        assert.equal(snapshot.board[4], "X");
        assert.equal(snapshot.turn, "O");
        assert.equal(matchDO.status, "active");

        // Игрок X получает уведомление о возвращении соперника
        const reconnectedNotice = await waitForMessage(socketX, "opponent_reconnected");
        assert.equal(reconnectedNotice.type, "opponent_reconnected");

        // Партия продолжается нормально: игрок O делает ход
        reconnectedSocket.send(JSON.stringify({ type: "make_move", index: 0, seq: 2 }));
        const moveApplied = await waitForMessage(reconnectedSocket, "move_applied");
        assert.equal(moveApplied.index, 0);
        assert.equal(moveApplied.role, "O");
    });

    // 14. Окончательный дисконнект (grace period expired -> abandoned)
    test("15. Окончательный дисконнект: техническое поражение после grace period", async () => {
        const { matchDO, socketX, socketO } = await setupDirectMatch(3);

        const endPromise = waitForMessage(socketX, "match_ended");

        // Игрок O отключается
        socketO.close();
        await waitForMessage(socketX, "opponent_disconnected");
        assert.equal(matchDO.status, "paused");

        // Истекает grace period, срабатывает Alarm
        await matchDO.alarm();

        const endResult = await endPromise;
        assert.equal(endResult.winner, "X");
        assert.equal(endResult.reason, "abandoned");
        assert.equal(matchDO.status, "completed");
    });

    // 15. Запись результатов в Cloudflare D1 и лидерборд без дублирования
    test("16. Запись результатов в D1 и обновление лидерборда без дублирования", async () => {
        const { matchDO, matchId } = await setupDirectMatch(3);

        // Завершаем матч победой X
        await matchDO.finishMatch("X", "win", [0, 1, 2]);

        // Проверяем запись в match_history
        const historyRows = mockD1._db.prepare("SELECT * FROM match_history WHERE match_id = ?").all(matchId);
        assert.equal(historyRows.length, 1);
        assert.equal(historyRows[0].winner_id, "user_x");
        assert.equal(historyRows[0].win_reason, "win");
        assert.equal(historyRows[0].board_size, 3);

        // Проверяем рейтинги в leaderboards
        const leaderRows = mockD1._db.prepare("SELECT * FROM leaderboards ORDER BY rating DESC").all();
        assert.equal(leaderRows.length, 2);

        const userXStats = leaderRows.find(r => r.vk_user_id === "user_x");
        const userOStats = leaderRows.find(r => r.vk_user_id === "user_o");

        assert.equal(userXStats.wins, 1);
        assert.equal(userXStats.rating, 1025); // Базовый 1000 + 25
        assert.equal(userOStats.losses, 1);
        assert.equal(userOStats.rating, 975); // Базовый 1000 - 25

        // Повторный вызов finishMatch (идемпотентность)
        await matchDO.finishMatch("X", "win", [0, 1, 2]);

        // Количество записей и рейтинги не должны измениться
        const historyRowsAfter = mockD1._db.prepare("SELECT * FROM match_history WHERE match_id = ?").all(matchId);
        assert.equal(historyRowsAfter.length, 1);

        const userXStatsAfter = mockD1._db.prepare("SELECT * FROM leaderboards WHERE vk_user_id = ?").all("user_x");
        assert.equal(userXStatsAfter[0].rating, 1025);
    });
});
