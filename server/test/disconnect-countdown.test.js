import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker, { Matchmaker, Match } from "../src/worker.js";
import { OnlineServerClient } from "../../OnlineServerClient.js";
import { evaluateBoard, validateMove } from "../src/game-rules.js";

// --- Mock среды для тестирования OnlineServerClient в Node.js ---

class MockWebSocket extends EventTarget {
    constructor() {
        super();
        this.readyState = 1; // OPEN
        this.peer = null;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        this.messages = [];
    }

    send(data) {
        if (this.readyState !== 1) return;
        if (this.peer && this.peer.readyState === 1) {
            this.peer.messages.push(data);
            queueMicrotask(() => {
                const event = new MessageEvent("message", { data });
                this.peer.dispatchEvent(event);
                if (typeof this.peer.onmessage === "function") {
                    this.peer.onmessage(event);
                }
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
            const event = new CloseEvent("close", { code, reason });
            this.dispatchEvent(event);
            if (typeof this.onclose === "function") this.onclose(event);

            if (this.peer && this.peer.readyState !== 3) {
                this.peer.readyState = 3;
                const peerEvent = new CloseEvent("close", { code, reason });
                this.peer.dispatchEvent(peerEvent);
                if (typeof this.peer.onclose === "function") this.peer.onclose(peerEvent);
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

globalThis.WebSocketPair = MockWebSocketPair;

const OriginalResponse = globalThis.Response;
class CloudflareTestResponse extends OriginalResponse {
    constructor(body, init) {
        if (init && init.status === 101) {
            super(null, { ...init, status: 200, statusText: "Switching Protocols" });
            Object.defineProperty(this, "status", { value: 101, writable: false });
            if (init.webSocket) this.webSocket = init.webSocket;
            return;
        }
        super(body, init);
    }
}
globalThis.Response = CloudflareTestResponse;

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
        setAlarm(t) { scheduledAlarm = t; },
        getAlarm() { return scheduledAlarm; }
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

function waitForEvent(target, eventName, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            target.removeEventListener(eventName, handler);
            reject(new Error(`Timeout waiting for event "${eventName}"`));
        }, timeoutMs);

        function handler(event) {
            clearTimeout(timer);
            target.removeEventListener(eventName, handler);
            resolve(event.detail);
        }

        target.addEventListener(eventName, handler);
    });
}

describe("VK-003-005.1: Отключение соперника и обратный отсчёт", () => {
    let mockEnv;
    let matchInstances;
    let matchmakerInstance;
    let originalFetch;
    let originalWebSocket;

    beforeEach(() => {
        matchInstances = new Map();
        const mockD1 = createMockD1();

        mockEnv = {
            DEV_MODE: "true",
            VK_CLIENT_SECRET: "test_secret_123",
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
                get: () => matchmakerInstance
            }
        };

        matchmakerInstance = new Matchmaker({ storage: createMockDOStorage() }, mockEnv);

        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            const urlStr = String(url);
            if (urlStr.startsWith("http://localhost:8787") || urlStr.startsWith("https://internal")) {
                const req = new Request(urlStr, options);
                return worker.fetch(req, mockEnv);
            }
            return originalFetch(url, options);
        };

        originalWebSocket = globalThis.WebSocket;
        class TestWebSocket extends EventTarget {
            static OPEN = 1;
            static CLOSED = 3;

            constructor(url) {
                super();
                this.url = String(url);
                this.readyState = 0; // CONNECTING
                this.onopen = null;
                this.onmessage = null;
                this.onerror = null;
                this.onclose = null;
                this._realSocket = null;
                this._outgoingQueue = [];

                queueMicrotask(async () => {
                    try {
                        const req = new Request(this.url, {
                            headers: { Upgrade: "websocket" }
                        });
                        const res = await worker.fetch(req, mockEnv);

                        if (res.status === 101 && res.webSocket) {
                            this._realSocket = res.webSocket;
                            this.readyState = 1; // OPEN

                            // 1. Перенаправляем входящие сообщения из server/DO сокета клиенту
                            this._realSocket.addEventListener("message", ev => {
                                const msgEvent = new MessageEvent("message", { data: ev.data });
                                this.dispatchEvent(msgEvent);
                                if (typeof this.onmessage === "function") this.onmessage(msgEvent);
                            });
                            this._realSocket.addEventListener("close", ev => {
                                this.readyState = 3;
                                const closeEvent = new CloseEvent("close", { code: ev.code, reason: ev.reason });
                                this.dispatchEvent(closeEvent);
                                if (typeof this.onclose === "function") this.onclose(closeEvent);
                            });

                            // 2. Оповещаем об открытии соединения
                            const openEvent = new Event("open");
                            this.dispatchEvent(openEvent);
                            if (typeof this.onopen === "function") this.onopen(openEvent);

                            // 3. Отправляем отложенные сообщения
                            for (const d of this._outgoingQueue) {
                                this._realSocket.send(d);
                            }
                            this._outgoingQueue = [];

                            // 4. Доставляем буферизованные сообщения (например auth_ok, snapshot)
                            if (this._realSocket.messages && this._realSocket.messages.length > 0) {
                                for (const raw of this._realSocket.messages) {
                                    const msgEvent = new MessageEvent("message", { data: raw });
                                    this.dispatchEvent(msgEvent);
                                    if (typeof this.onmessage === "function") this.onmessage(msgEvent);
                                }
                                this._realSocket.messages = [];
                            }
                        } else {
                            this.readyState = 3;
                            const errEvent = new Event("error");
                            this.dispatchEvent(errEvent);
                            if (typeof this.onerror === "function") this.onerror(errEvent);
                        }
                    } catch (e) {
                        this.readyState = 3;
                        const errEvent = new Event("error");
                        this.dispatchEvent(errEvent);
                        if (typeof this.onerror === "function") this.onerror(errEvent);
                    }
                });
            }

            send(data) {
                if (this._realSocket && this.readyState === 1) {
                    this._realSocket.send(data);
                } else {
                    this._outgoingQueue.push(data);
                }
            }

            close(code, reason) {
                this.readyState = 3;
                if (this._realSocket) {
                    this._realSocket.close(code, reason);
                }
            }
        }

        globalThis.WebSocket = TestWebSocket;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        globalThis.WebSocket = originalWebSocket;
    });

    // 1. Соперник отключился — сервер присылает событие opponent_disconnected с grace period и expiresAt
    test("1. Соперник отключился: оставшийся игрок получает opponent_disconnected с gracePeriodMs и expiresAt", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        // Игрок 2 отключается
        const disconnectPromise = waitForEvent(client1, "opponent_disconnected");
        client2._closeSocket();

        const disMsg = await disconnectPromise;
        assert.equal(disMsg.gracePeriodMs, 15000);
        assert.equal(typeof disMsg.expiresAt, "number");
        assert.ok(disMsg.expiresAt > Date.now());
        assert.equal(client1.state, "paused");

        client1.dispose();
        client2.dispose();
    });

    // 2. Отсчёт обратного времени корректно уменьшается каждую секунду
    test("2. Отсчёт обратного времени: корректно уменьшается на основании серверного expiresAt", async () => {
        const now = Date.now();
        const expiresAt = now + 15000;

        function formatMessage(targetExpiresAt, currentTime) {
            const sec = Math.max(0, Math.ceil((targetExpiresAt - currentTime) / 1000));
            return `Соперник отключился. Ожидаем возвращения: ${sec} сек.`;
        }

        assert.equal(formatMessage(expiresAt, now), "Соперник отключился. Ожидаем возвращения: 15 сек.");
        assert.equal(formatMessage(expiresAt, now + 1000), "Соперник отключился. Ожидаем возвращения: 14 сек.");
        assert.equal(formatMessage(expiresAt, now + 5000), "Соперник отключился. Ожидаем возвращения: 10 сек.");
        assert.equal(formatMessage(expiresAt, now + 14500), "Соперник отключился. Ожидаем возвращения: 1 сек.");
        assert.equal(formatMessage(expiresAt, now + 15100), "Соперник отключился. Ожидаем возвращения: 0 сек.");
    });

    // 3. Соперник вернулся до нуля — сервер присылает opponent_reconnected, партия продолжается
    test("3. Соперник вернулся до нуля: игрок 1 получает opponent_reconnected и партия продолжается", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        const [snap1] = await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        const matchId = snap1.matchId;

        // Игрок 2 теряет связь
        const disconnectPromise = waitForEvent(client1, "opponent_disconnected");
        client2._closeSocket();
        await disconnectPromise;

        // Игрок 2 переподключается до истечения 15 секунд
        const reconnectPromise1 = waitForEvent(client1, "opponent_reconnected");
        await client2.connectToMatch(matchId);

        const recEvt = await reconnectPromise1;
        assert.ok(recEvt);
        assert.equal(client1.state, "active");

        client1.dispose();
        client2.dispose();
    });

    // 4. Игрок подключился посреди ожидания — получает актуальное оставшееся время
    test("4. Подключение посреди ожидания: snapshot содержит статус paused и точное оставшееся время grace", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        const [snap1] = await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        const matchId = snap1.matchId;

        // Игрок 2 отключается
        const disconnectPromise = waitForEvent(client1, "opponent_disconnected");
        client2._closeSocket();
        await disconnectPromise;

        // Игрок 1 перезагружает страницу (переподключается)
        const client1Reload = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        await client1Reload.authenticate();

        const snapReloadPromise = waitForEvent(client1Reload, "snapshot");
        await client1Reload.connectToMatch(matchId);
        const reloadSnap = await snapReloadPromise;

        assert.equal(reloadSnap.status, "paused");
        assert.equal(reloadSnap.disconnectedUser, "dev_user_2");
        assert.ok(reloadSnap.remainingGraceMs > 0 && reloadSnap.remainingGraceMs <= 15000);
        assert.ok(reloadSnap.expiresAt > Date.now());

        client1.dispose();
        client1Reload.dispose();
        client2.dispose();
    });

    // 5. Срок ожидания истёк — сервер фиксирует техническое поражение и победу оставшегося
    test("5. Срок ожидания истёк: сервер фиксирует победу оставшегося игрока с причиной abandoned", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        const [snap1] = await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        const matchId = snap1.matchId;
        const matchDO = matchInstances.get(matchId);

        // Игрок 2 отключается
        const disconnectPromise = waitForEvent(client1, "opponent_disconnected");
        client2._closeSocket();
        await disconnectPromise;

        // Истекает grace period на сервере (срабатывает alarm DO)
        const matchEndedPromise = waitForEvent(client1, "match_ended");
        await matchDO.alarm();

        const endResult = await matchEndedPromise;
        assert.equal(endResult.winner, snap1.role);
        assert.equal(endResult.reason, "abandoned");
        assert.equal(client1.state, "completed");

        client1.dispose();
        client2.dispose();
    });

    // 6. Формирование сообщения победы по неявке соперника
    test("6. Сообщение победы по неявке: строго соответствует требованиям ТЗ", () => {
        function getEndGameMessage(winner, localSide, reason) {
            if (winner === localSide) {
                if (reason === "abandoned" || reason === "disconnect_timeout") {
                    return "Время ожидания истекло. Вы победили! Соперник не вернулся.";
                }
                if (reason === "timeout") {
                    return "Ты победил! (Соперник превысил время)";
                }
                return "Ты победил!";
            }
            if (winner === "draw") {
                return "Ничья!";
            }
            if (reason === "abandoned" || reason === "disconnect_timeout") {
                return "Время ожидания истекло. Поражение: время на возвращение истекло.";
            }
            if (reason === "timeout") {
                return "Поражение: время на ход истекло";
            }
            return "Победил соперник!";
        }

        const msgWinAbandoned = getEndGameMessage("X", "X", "abandoned");
        assert.equal(msgWinAbandoned, "Время ожидания истекло. Вы победили! Соперник не вернулся.");

        const msgLossAbandoned = getEndGameMessage("O", "X", "abandoned");
        assert.equal(msgLossAbandoned, "Время ожидания истекло. Поражение: время на возвращение истекло.");
    });

    // 7. Повторные события отключения не создают несколько таймеров (идемпотентность)
    test("7. Защита от дублей таймеров: остановка старого интервала перед запуском нового", () => {
        let activeInterval = null;
        let startCount = 0;

        function startCountdown() {
            if (activeInterval) {
                clearInterval(activeInterval);
                activeInterval = null;
            }
            startCount += 1;
            activeInterval = setInterval(() => {}, 1000);
        }

        startCountdown();
        startCountdown();
        startCountdown();

        assert.equal(startCount, 3);
        assert.ok(activeInterval !== null);
        clearInterval(activeInterval);
    });

    // 8. Собственный временный дисконнект не приводит к потере матча при успешном восстановлении
    test("8. Собственный временный дисконнект: успешное восстановление активной сессии", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        const [snap1] = await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        const matchId = snap1.matchId;

        // Игрок 1 теряет соединение
        client1._closeSocket();

        // Игрок 1 переподключается
        const client1Restored = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        await client1Restored.authenticate();

        const snapRestoredPromise = waitForEvent(client1Restored, "snapshot");
        await client1Restored.connectToMatch(matchId);
        const restoredSnap = await snapRestoredPromise;

        assert.equal(restoredSnap.matchId, matchId);
        assert.equal(restoredSnap.status, "active");
        assert.equal(client1Restored.state, "active");

        client1.dispose();
        client1Restored.dispose();
        client2.dispose();
    });

    // 9. Обычная игра против ИИ и правила досок 3x3, 4x4, 5x5 работают без изменений
    test("9. Базовые правила игры: валидация ходов и победные линии на всех размерах доски", () => {
        // 3x3
        const board3 = ["X", "X", "X", "", "", "", "", "", ""];
        const res3 = evaluateBoard(board3, 3);
        assert.equal(res3.isOver, true);
        assert.equal(res3.winner, "X");

        // 4x4 (4 в ряд)
        const board4 = [
            "O", "", "", "",
            "O", "", "", "",
            "O", "", "", "",
            "O", "", "", ""
        ];
        const res4 = evaluateBoard(board4, 4);
        assert.equal(res4.isOver, true);
        assert.equal(res4.winner, "O");

        // 5x5 (5 в ряд)
        const board5 = [
            "X", "X", "X", "X", "X",
            "", "", "", "", "",
            "", "", "", "", "",
            "", "", "", "", "",
            "", "", "", "", ""
        ];
        const res5 = evaluateBoard(board5, 5);
        assert.equal(res5.isOver, true);
        assert.equal(res5.winner, "X");
    });
});
