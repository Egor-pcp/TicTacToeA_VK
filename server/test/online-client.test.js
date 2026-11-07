import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker, { Matchmaker, Match } from "../src/worker.js";
import { OnlineServerClient } from "../../OnlineServerClient.js";

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

describe("Клиентский модуль OnlineServerClient", () => {
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

        // Перехват fetch для локального URL
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            const urlStr = String(url);
            if (urlStr.startsWith("http://localhost:8787") || urlStr.startsWith("https://internal")) {
                const req = new Request(urlStr, options);
                return worker.fetch(req, mockEnv);
            }
            return originalFetch(url, options);
        };

        // Подключение WebSocket к worker.fetch
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

                            // 4. Доставляем буферизованные сообщения (например auth_ok)
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

    test("1. authenticate: получение токена для dev_user_1", async () => {
        const client = new OnlineServerClient({
            serverUrl: "http://localhost:8787",
            devUser: "dev_user_1"
        });

        const authData = await client.authenticate();
        assert.equal(authData.userId, "dev_user_1");
        assert.equal(authData.dev, true);
        assert.equal(typeof authData.token, "string");
        assert.equal(client.token, authData.token);
    });

    test("2. startSearch и cancelSearch", async () => {
        const client = new OnlineServerClient({
            serverUrl: "http://localhost:8787",
            devUser: "dev_user_1"
        });

        const searchPromise = waitForEvent(client, "searching");
        await client.startSearch(3);
        const searchDetail = await searchPromise;
        assert.equal(searchDetail.boardSize, 3);
        assert.equal(client.state, "searching");

        const cancelPromise = waitForEvent(client, "search_canceled");
        client.cancelSearch();
        await cancelPromise;
        assert.equal(client.state, "idle");
    });

    test("3. Сквозной онлайн-матч между двумя клиентами (ход, подтверждение, победа)", async () => {
        const client1 = new OnlineServerClient({
            serverUrl: "http://localhost:8787",
            devUser: "dev_user_1"
        });
        const client2 = new OnlineServerClient({
            serverUrl: "http://localhost:8787",
            devUser: "dev_user_2"
        });

        const startPromise1 = waitForEvent(client1, "match_start");
        const startPromise2 = waitForEvent(client2, "match_start");

        await client1.startSearch(3, { name: "Алиса" });
        await client2.startSearch(3, { name: "Боб" });

        const [start1, start2] = await Promise.all([startPromise1, startPromise2]);
        assert.equal(start1.matchId, start2.matchId);
        assert.notEqual(start1.role, start2.role);

        // Ждем получения snapshots от Match DO для обоих клиентов
        const snapPromise1 = waitForEvent(client1, "snapshot");
        const snapPromise2 = waitForEvent(client2, "snapshot");
        const [snap1, snap2] = await Promise.all([snapPromise1, snapPromise2]);

        assert.equal(snap1.matchId, start1.matchId);
        assert.equal(snap2.matchId, start1.matchId);
        assert.equal(snap1.turn, "X");

        const clientX = client1.role === "X" ? client1 : client2;
        const clientO = client1.role === "O" ? client1 : client2;

        // Ход 1: X ходит в клетку 0
        const move1PromiseX = waitForEvent(clientX, "move_applied");
        const move1PromiseO = waitForEvent(clientO, "move_applied");
        clientX.makeMove(0);
        const [m1X, m1O] = await Promise.all([move1PromiseX, move1PromiseO]);
        assert.equal(m1X.index, 0);
        assert.equal(m1X.role, "X");
        assert.equal(m1X.nextTurn, "O");

        // Ход 2: O ходит в клетку 3
        const move2PromiseX = waitForEvent(clientX, "move_applied");
        const move2PromiseO = waitForEvent(clientO, "move_applied");
        clientO.makeMove(3);
        await Promise.all([move2PromiseX, move2PromiseO]);

        // Ход 3: X ходит в клетку 1
        const move3Promise = waitForEvent(clientX, "move_applied");
        clientX.makeMove(1);
        await move3Promise;

        // Ход 4: O ходит в клетку 4
        const move4Promise = waitForEvent(clientO, "move_applied");
        clientO.makeMove(4);
        await move4Promise;

        // Ход 5: X ходит в клетку 2 -> Победа X [0, 1, 2]
        const endPromiseX = waitForEvent(clientX, "match_ended");
        const endPromiseO = waitForEvent(clientO, "match_ended");
        clientX.makeMove(2);

        const [endX, endO] = await Promise.all([endPromiseX, endPromiseO]);
        assert.equal(endX.winner, "X");
        assert.equal(endX.reason, "win");
        assert.deepEqual(endX.winningLine, [0, 1, 2]);
        assert.equal(endO.winner, "X");

        client1.dispose();
        client2.dispose();
    });

    test("4. Отклонение хода не в свою очередь", async () => {
        const client1 = new OnlineServerClient({
            serverUrl: "http://localhost:8787",
            devUser: "dev_user_1"
        });
        const client2 = new OnlineServerClient({
            serverUrl: "http://localhost:8787",
            devUser: "dev_user_2"
        });

        await Promise.all([
            client1.startSearch(3),
            client2.startSearch(3)
        ]);

        await Promise.all([
            waitForEvent(client1, "snapshot"),
            waitForEvent(client2, "snapshot")
        ]);

        const clientO = client1.role === "O" ? client1 : client2;

        // O пытается походить первым (хотя очередь у X)
        const invalidPromise = waitForEvent(clientO, "invalid_move");
        clientO.makeMove(0);
        const invalidDetail = await invalidPromise;
        assert.equal(invalidDetail.reason, "Not your turn");

        client1.dispose();
        client2.dispose();
    });

    test("5. Ничья на доске 3x3 (draw)", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        const clientX = client1.role === "X" ? client1 : client2;
        const clientO = client1.role === "O" ? client1 : client2;

        // Ничейная партия:
        // X: 0, 2, 3, 7, 8
        // O: 1, 4, 5, 6
        const turns = [
            { c: clientX, idx: 0 },
            { c: clientO, idx: 1 },
            { c: clientX, idx: 2 },
            { c: clientO, idx: 4 },
            { c: clientX, idx: 3 },
            { c: clientO, idx: 5 },
            { c: clientX, idx: 7 },
            { c: clientO, idx: 6 }
        ];

        for (const t of turns) {
            const p = waitForEvent(t.c, "move_applied");
            t.c.makeMove(t.idx);
            await p;
        }

        const endPromise = waitForEvent(clientX, "match_ended");
        clientX.makeMove(8); // Финальный ход в клетку 8

        const endResult = await endPromise;
        assert.equal(endResult.winner, "draw");
        assert.equal(endResult.reason, "draw");

        client1.dispose();
        client2.dispose();
    });

    test("6. Онлайн-матч на доске 4x4", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(4), client2.startSearch(4)]);
        const [snap1, snap2] = await Promise.all([
            waitForEvent(client1, "snapshot"),
            waitForEvent(client2, "snapshot")
        ]);

        assert.equal(snap1.boardSize, 4);
        assert.equal(snap2.boardSize, 4);
        assert.equal(snap1.board.length, 16);

        client1.dispose();
        client2.dispose();
    });

    test("7. Временный дисконнект и восстановление связи (reconnect)", async () => {
        const client1 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_1" });
        const client2 = new OnlineServerClient({ serverUrl: "http://localhost:8787", devUser: "dev_user_2" });

        await Promise.all([client1.startSearch(3), client2.startSearch(3)]);
        await Promise.all([waitForEvent(client1, "snapshot"), waitForEvent(client2, "snapshot")]);

        const clientX = client1.role === "X" ? client1 : client2;
        const clientO = client1.role === "O" ? client1 : client2;

        // X делает ход
        const movePromise = waitForEvent(clientX, "move_applied");
        clientX.makeMove(4);
        await movePromise;

        // Игрок O теряет соединение
        const disPromise = waitForEvent(clientX, "opponent_disconnected");
        clientO._closeSocket();
        const disDetail = await disPromise;
        assert.equal(disDetail.gracePeriodMs, 15000);

        // Игрок O переподключается к тому же матчу
        const reconnectPromiseO = waitForEvent(clientO, "snapshot");
        const reconnectedNoticeX = waitForEvent(clientX, "opponent_reconnected");

        await clientO.connectToMatch(clientX.currentMatchId);

        const [snapO, noticeX] = await Promise.all([reconnectPromiseO, reconnectedNoticeX]);
        assert.equal(snapO.matchId, clientX.currentMatchId);
        assert.equal(snapO.board[4], "X");
        assert.equal(snapO.turn, "O");

        client1.dispose();
        client2.dispose();
    });
});
