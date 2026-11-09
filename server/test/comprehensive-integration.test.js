import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import worker, { Matchmaker, Match } from "../src/worker.js";
import { OnlineServerClient } from "../../OnlineServerClient.js";
import {
    MockPlatformAdapter,
    VkBridgeAdapter,
    createPlatformAdapter,
    isDevelopmentEnvironment,
    AdCooldownManager
} from "../../platform-adapter.js";
import {
    addCompletedMatch,
    getSavedMatches,
    getCategoryStats,
    getPlayerStatsStorageKey
} from "../../player-stats.js";

// --- Mock инфраструктуры WebSocket для интеграционных тестов Node.js ---

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

describe("VK-003-008: Комплексное локальное тестирование (Этапы C, D, E, F, G, H, I)", () => {
    let mockEnv;
    let matchInstances;
    let matchmakerInstance;
    let originalFetch;
    let originalWebSocket;
    let activeClients = [];

    function createClient(options) {
        const client = new OnlineServerClient(options);
        activeClients.push(client);
        return client;
    }

    async function pairClients(c1, c2, boardSize = 3) {
        await c1.authenticate();
        await c2.authenticate();

        const start1 = waitForEvent(c1, "match_start");
        const start2 = waitForEvent(c2, "match_start");
        const snap1 = waitForEvent(c1, "snapshot");
        const snap2 = waitForEvent(c2, "snapshot");

        await c1.startSearch({ boardSize });
        await c2.startSearch({ boardSize });

        const [m1, m2] = await Promise.all([start1, start2]);
        await Promise.all([snap1, snap2]);

        assert.equal(m1.matchId, m2.matchId);
        assert.equal(c1.role !== c2.role, true);
        assert.equal(c1.state, "active");
        assert.equal(c2.state, "active");

        const xClient = c1.role === "X" ? c1 : c2;
        const oClient = c1.role === "O" ? c1 : c2;

        return { xClient, oClient, matchId: m1.matchId };
    }

    async function playMove(turnClient, otherClient, index) {
        const moveOther = waitForEvent(otherClient, "move_applied");
        const moveTurn = waitForEvent(turnClient, "move_applied");
        turnClient.makeMove(index);
        const [mO, mT] = await Promise.all([moveOther, moveTurn]);
        assert.equal(mO.index, index);
        assert.equal(mT.index, index);
    }

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

                            const openEvent = new Event("open");
                            this.dispatchEvent(openEvent);
                            if (typeof this.onopen === "function") this.onopen(openEvent);

                            for (const d of this._outgoingQueue) {
                                this._realSocket.send(d);
                            }
                            this._outgoingQueue = [];

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
                const closeEvent = new CloseEvent("close", { code: code || 1000, reason });
                this.dispatchEvent(closeEvent);
                if (typeof this.onclose === "function") this.onclose(closeEvent);
            }
        }
        globalThis.WebSocket = TestWebSocket;
    });

    afterEach(() => {
        while (activeClients.length > 0) {
            try {
                activeClients.pop().dispose();
            } catch {}
        }
        try {
            sessionStorage.clear();
        } catch {}
        globalThis.fetch = originalFetch;
        globalThis.WebSocket = originalWebSocket;
    });

    // --- Этап C: Два локальных пользователя ---

    test("Этап C: Авторизация и независимый матч двух игроков dev_user_1 и dev_user_2", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        // 1. Независимая авторизация
        const auth1 = await client1.authenticate();
        const auth2 = await client2.authenticate();
        assert.equal(auth1.userId, "dev_user_1");
        assert.equal(auth2.userId, "dev_user_2");
        assert.notEqual(auth1.token, auth2.token);

        // 2. Поиск соперника и переход в активное состояние
        const { xClient, oClient } = await pairClients(client1, client2, 3);

        // 3. Запрет хода не в свою очередь: сервер возвращает invalid_move
        const invalidTurnPromise = waitForEvent(oClient, "invalid_move");
        oClient.makeMove(4);
        const invTurn = await invalidTurnPromise;
        assert.equal(invTurn.reason, "Not your turn");

        // 4. Корректный ход X в ячейку 4
        await playMove(xClient, oClient, 4);

        // 5. Запрет хода в уже занятую ячейку 4
        const invalidCellPromise = waitForEvent(oClient, "invalid_move");
        oClient.makeMove(4);
        const invCell = await invalidCellPromise;
        assert.equal(invCell.reason, "Cell is already occupied");

        // 6. Корректный ход O в свободную ячейку 0
        await playMove(oClient, xClient, 0);
    });

    // --- Этап D: Поиск соперника и отмена ---

    test("Этап D: Отмена поиска, быстрый перезапуск и FIFO-порядок Matchmaker", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });
        await client1.authenticate();
        await client2.authenticate();

        // 1. Игрок 1 встает в поиск и отменяет
        await client1.startSearch({ boardSize: 3 });
        assert.equal(client1.state, "searching");

        await client1.cancelSearch();
        assert.equal(client1.state, "idle");

        // 2. Игрок 2 встает в поиск — матча нет, т.к. игрок 1 отменил
        await client2.startSearch({ boardSize: 3 });
        assert.equal(client2.state, "searching");

        // 3. Игрок 1 повторно встает в поиск — образуется матч
        const matchPromise = waitForEvent(client2, "match_start");
        await client1.startSearch({ boardSize: 3 });

        const match = await matchPromise;
        assert.equal(typeof match.matchId, "string");
        assert.equal(match.boardSize, 3);
    });

    // --- Этап E: Отключение и восстановление соединения ---

    test("Этап E.1: Временное отключение соперника и успешный reconnect", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        const { xClient, oClient, matchId } = await pairClients(client1, client2, 3);

        // Первый ход делает X
        await playMove(xClient, oClient, 4);

        // Игрок O имитирует разрыв интернет-соединения
        const discPromise = waitForEvent(xClient, "opponent_disconnected");
        oClient._socket.close(1001, "Network dropped");
        const discEvent = await discPromise;
        assert.equal(discEvent.gracePeriodMs, 15000);
        assert.equal(xClient.state, "paused");

        // Игрок O восстанавливает связь (reconnect)
        const reconnPromise = waitForEvent(xClient, "opponent_reconnected");
        const snapPromiseO = waitForEvent(oClient, "snapshot");
        await oClient.connectToMatch(matchId);
        await Promise.all([reconnPromise, snapPromiseO]);

        assert.equal(xClient.state, "active");
        assert.equal(oClient.state, "active");

        // Матч бесшовно продолжается: ход O в ячейку 0
        await playMove(oClient, xClient, 0);
    });

    test("Этап E.2: Истечение времени ожидания (15с) присуждает техническую победу оставшемуся", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        const { xClient, oClient, matchId } = await pairClients(client1, client2, 3);
        const matchDO = matchInstances.get(matchId);

        // Игрок O отключается
        const discPromise = waitForEvent(xClient, "opponent_disconnected");
        oClient._socket.close(1001, "Disconnected");
        await discPromise;

        // Срабатывает Alarm 15-секундного grace period
        const endPromise = waitForEvent(xClient, "match_ended");
        await matchDO.alarm();

        const endEvent = await endPromise;
        assert.equal(endEvent.winner, xClient.role);
        assert.equal(endEvent.reason, "abandoned");
        assert.equal(xClient.state, "completed");
    });

    // --- Этап F: Тайм-ауты ходов (30 секунд) ---

    test("Этап F: Тайм-аут хода (30 секунд) присуждает победу ожидающему игроку", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        const { xClient, oClient, matchId } = await pairClients(client1, client2, 3);
        const matchDO = matchInstances.get(matchId);

        // Игрок X не ходит вовремя: тайм-аут 30 секунд истекает
        matchDO.turnDeadline = Date.now() - 1;
        const endPromiseO = waitForEvent(oClient, "match_ended");
        const endPromiseX = waitForEvent(xClient, "match_ended");
        await matchDO.alarm();

        const [endO, endX] = await Promise.all([endPromiseO, endPromiseX]);
        assert.equal(endO.winner, "O");
        assert.equal(endO.reason, "timeout");
        assert.equal(endX.winner, "O");
        assert.equal(endX.reason, "timeout");
    });

    // --- Этап G: Статистика, профиль и Cloudflare D1 ---

    test("Этап G: Авторитетная запись итогов матча в Cloudflare D1 и лидерборд", async () => {
        const d1 = mockEnv.DB;
        const matchStorage = createMockDOStorage();
        const match = new Match({ storage: matchStorage }, mockEnv);

        match.handleInit({
            matchId: "test-match-d1-100",
            boardSize: 3,
            playerX: { id: "dev_user_1", name: "Игрок 1 (Dev)" },
            playerO: { id: "dev_user_2", name: "Игрок 2 (Dev)" }
        });

        // Завершение матча: победа игрока X
        await match.finishMatch("X", "win");

        // Проверяем таблицу match_history
        const history = await d1.prepare("SELECT * FROM match_history WHERE match_id = ?").bind("test-match-d1-100").all();
        assert.equal(history.results.length, 1);
        assert.equal(history.results[0].winner_id, "dev_user_1");
        assert.equal(history.results[0].win_reason, "win");

        // Проверяем изменение рейтинга: dev_user_1 = 1025, dev_user_2 = 975
        const lb1 = await d1.prepare("SELECT * FROM leaderboards WHERE vk_user_id = ?").bind("dev_user_1").all();
        const lb2 = await d1.prepare("SELECT * FROM leaderboards WHERE vk_user_id = ?").bind("dev_user_2").all();
        assert.equal(lb1.results[0].rating, 1025);
        assert.equal(lb1.results[0].wins, 1);
        assert.equal(lb2.results[0].rating, 975);
        assert.equal(lb2.results[0].losses, 1);

        // Идемпотентность: повторный вызов finishMatch не дублирует начисление рейтинга
        await match.finishMatch("X", "win");
        const lb1After = await d1.prepare("SELECT * FROM leaderboards WHERE vk_user_id = ?").bind("dev_user_1").all();
        assert.equal(lb1After.results[0].rating, 1025);

        // Проверяем эндпоинт API /api/leaderboard
        const req = new Request("http://localhost:8787/api/leaderboard");
        const res = await worker.fetch(req, mockEnv);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.leaderboard.length >= 2, true);
        assert.equal(data.leaderboard[0].vk_user_id, "dev_user_1");
        assert.equal(data.leaderboard[0].rating, 1025);
        assert.equal(data.leaderboard[1].vk_user_id, "dev_user_2");
        assert.equal(data.leaderboard[1].rating, 975);
    });

    // --- Этап H: Платформенный адаптер и рекламный кулдаун ---

    test("Этап H: Показ рекламы после завершения матча и защита кулдауна 60с", async () => {
        const mockAdapter = new MockPlatformAdapter({ devUser: "dev_user_1" });
        const manager = new AdCooldownManager({ platformAdapter: mockAdapter, cooldownMs: 60000 });

        // Матч 1 завершился — показ успешен
        const ad1 = await manager.maybeShowInterstitialAd();
        assert.equal(ad1, true);
        assert.equal(manager.getLastAdShownAt() > 0, true);

        // Немедленный матч 2 завершился — кулдаун защищает (false, реклама не вызвана)
        const ad2 = await manager.maybeShowInterstitialAd();
        assert.equal(ad2, false);
        assert.equal(mockAdapter.adsCallCount, 1);

        // Имитируем сбой показа рекламы на сбойном адаптере
        const failingAdapter = new MockPlatformAdapter({ adMockResult: false });
        const failManager = new AdCooldownManager({ platformAdapter: failingAdapter, cooldownMs: 60000 });
        const failResult = await failManager.maybeShowInterstitialAd();
        assert.equal(failResult, false);
        assert.equal(failManager.getLastAdShownAt(), 0); // Кулдаун не активирован!

        // Защита Production от несанкционированного включения Dev Mode (VK-003-007.2)
        const isProdSafe = isDevelopmentEnvironment({ hostname: "prod-app.vk.com", searchUrl: "?dev_user=dev_user_1" });
        assert.equal(isProdSafe, false);

        const prodAdapter = createPlatformAdapter({ hostname: "prod-app.vk.com", forceMode: "development" });
        assert.equal(prodAdapter.isMock, false);
        assert.equal(prodAdapter.mode, "vk_mini_apps");
    });

    // --- Этап I: Сквозные онлайн-партии для всех исходов ---

    test("Этап I.1: Сквозной интеграционный матч с победой X", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        const { xClient, oClient } = await pairClients(client1, client2, 3);

        // Разыгрываем победу X по верхней горизонтали [0, 1, 2]:
        // 1. X -> 0
        await playMove(xClient, oClient, 0);
        // 2. O -> 3
        await playMove(oClient, xClient, 3);
        // 3. X -> 1
        await playMove(xClient, oClient, 1);
        // 4. O -> 4
        await playMove(oClient, xClient, 4);

        // 5. X -> 2 (Победный ход)
        const endPromiseX = waitForEvent(xClient, "match_ended");
        const endPromiseO = waitForEvent(oClient, "match_ended");
        xClient.makeMove(2);

        const [endX, endO] = await Promise.all([endPromiseX, endPromiseO]);
        assert.equal(endX.winner, "X");
        assert.equal(endO.winner, "X");
        assert.equal(endX.reason, "win");
        assert.equal(endO.reason, "win");
        assert.deepEqual(endX.winningLine, [0, 1, 2]);
    });

    test("Этап I.2: Сквозной интеграционный матч с победой O", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        const { xClient, oClient } = await pairClients(client1, client2, 3);

        // Разыгрываем победу O по второй горизонтали [3, 4, 5]:
        // 1. X -> 0
        await playMove(xClient, oClient, 0);
        // 2. O -> 3
        await playMove(oClient, xClient, 3);
        // 3. X -> 1
        await playMove(xClient, oClient, 1);
        // 4. O -> 4
        await playMove(oClient, xClient, 4);
        // 5. X -> 8
        await playMove(xClient, oClient, 8);

        // 6. O -> 5 (Победный ход)
        const endPromiseX = waitForEvent(xClient, "match_ended");
        const endPromiseO = waitForEvent(oClient, "match_ended");
        oClient.makeMove(5);

        const [endX, endO] = await Promise.all([endPromiseX, endPromiseO]);
        assert.equal(endX.winner, "O");
        assert.equal(endO.winner, "O");
        assert.equal(endX.reason, "win");
        assert.equal(endO.reason, "win");
        assert.deepEqual(endX.winningLine, [3, 4, 5]);
    });

    test("Этап I.3: Сквозной интеграционный матч с ничьей (draw)", async () => {
        const client1 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = createClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        const { xClient, oClient } = await pairClients(client1, client2, 3);

        // Разыгрываем классическую ничью:
        // 0(X) 1(O) 2(X)
        // 3(X) 4(O) 5(O)
        // 6(O) 7(X) 8(X)
        await playMove(xClient, oClient, 0);
        await playMove(oClient, xClient, 1);
        await playMove(xClient, oClient, 2);
        await playMove(oClient, xClient, 4);
        await playMove(xClient, oClient, 3);
        await playMove(oClient, xClient, 5);
        await playMove(xClient, oClient, 7);
        await playMove(oClient, xClient, 6);

        // Завершающий ход X в ячейку 8 — ничья!
        const endPromiseX = waitForEvent(xClient, "match_ended");
        const endPromiseO = waitForEvent(oClient, "match_ended");
        xClient.makeMove(8);

        const [endX, endO] = await Promise.all([endPromiseX, endPromiseO]);
        assert.equal(endX.winner, "draw");
        assert.equal(endO.winner, "draw");
        assert.equal(endX.reason, "draw");
        assert.equal(endO.reason, "draw");
    });
});
