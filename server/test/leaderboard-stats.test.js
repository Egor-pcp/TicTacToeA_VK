import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.js";
import { Match } from "../src/match.js";
import {
    PLAYER_PROFILE_STORAGE_KEY,
    PLAYER_STATS_STORAGE_KEY,
    getPlayerStatsStorageKey,
    getPlayerProfileStorageKey,
    getOrCreatePlayerIdentity,
    getSavedMatches,
    addCompletedMatch,
    getCategoryStats,
    getOverallStats
} from "../../player-stats.js";

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

function createMockStorage() {
    const store = new Map();
    return {
        _map: store,
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        }
    };
}

function createMockMatchDO(matchId, env = {}) {
    return new Match({
        storage: {
            get: async () => null,
            put: async () => {},
            delete: async () => {},
            setAlarm: () => {}
        }
    }, env);
}

describe("VK-003-006: Изоляция персональной статистики (player-stats.js)", () => {
    test("1. Ключи хранилища формируются изолированно по userId", () => {
        assert.equal(getPlayerStatsStorageKey("dev_user_1"), "tictactoe.vk_dev_user_1.stats.v1");
        assert.equal(getPlayerStatsStorageKey("dev_user_2"), "tictactoe.vk_dev_user_2.stats.v1");
        assert.equal(getPlayerStatsStorageKey("vk_777"), "tictactoe.vk_777.stats.v1");
        assert.equal(getPlayerStatsStorageKey("777"), "tictactoe.vk_777.stats.v1");
        assert.equal(getPlayerStatsStorageKey(null), PLAYER_STATS_STORAGE_KEY);
        assert.equal(getPlayerStatsStorageKey(undefined), PLAYER_STATS_STORAGE_KEY);
        assert.equal(getPlayerStatsStorageKey(""), PLAYER_STATS_STORAGE_KEY);

        assert.equal(getPlayerProfileStorageKey("dev_user_1"), "tictactoe.vk_dev_user_1.profile.v1");
        assert.equal(getPlayerProfileStorageKey("dev_user_2"), "tictactoe.vk_dev_user_2.profile.v1");
        assert.equal(getPlayerProfileStorageKey(null), PLAYER_PROFILE_STORAGE_KEY);
    });

    test("2. Профили игроков создаются раздельно и не пересекаются", () => {
        const storage = createMockStorage();

        const profile1 = getOrCreatePlayerIdentity({ storage, userId: "dev_user_1" });
        const profile2 = getOrCreatePlayerIdentity({ storage, userId: "dev_user_2" });
        const legacyProfile = getOrCreatePlayerIdentity({ storage });

        assert.equal(profile1.displayId, "vk_dev_user_1");
        assert.equal(profile2.displayId, "vk_dev_user_2");
        assert.match(legacyProfile.displayId, /^ID_\d{10}$/);

        assert.notEqual(profile1.identityKey, profile2.identityKey);
        assert.equal(storage.getItem("tictactoe.vk_dev_user_1.profile.v1") !== null, true);
        assert.equal(storage.getItem("tictactoe.vk_dev_user_2.profile.v1") !== null, true);
        assert.equal(storage.getItem(PLAYER_PROFILE_STORAGE_KEY) !== null, true);
    });

    test("3. Статистика dev_user_1 и dev_user_2 полностью изолирована", () => {
        const storage = createMockStorage();

        const matchUser1 = {
            id: "match-u1-1",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "online",
            boardSize: 3,
            difficulty: "medium",
            durationMs: 12000
        };

        const matchUser2 = {
            id: "match-u2-1",
            completedAt: new Date().toISOString(),
            result: "loss",
            winner: "X",
            mode: "online",
            boardSize: 3,
            difficulty: "medium",
            durationMs: 12000
        };

        assert.equal(addCompletedMatch(matchUser1, { storage, userId: "dev_user_1" }), true);
        assert.equal(addCompletedMatch(matchUser2, { storage, userId: "dev_user_2" }), true);

        // Проверяем сохраненные матчи
        const matchesUser1 = getSavedMatches({ storage, userId: "dev_user_1" });
        const matchesUser2 = getSavedMatches({ storage, userId: "dev_user_2" });

        assert.equal(matchesUser1.length, 1);
        assert.equal(matchesUser1[0].id, "match-u1-1");
        assert.equal(matchesUser1[0].result, "win");

        assert.equal(matchesUser2.length, 1);
        assert.equal(matchesUser2[0].id, "match-u2-1");
        assert.equal(matchesUser2[0].result, "loss");

        // Проверяем статистику по категориям
        const statsUser1 = getCategoryStats("medium", 3, { storage, userId: "dev_user_1" });
        assert.equal(statsUser1.gamesPlayed, 1);
        assert.equal(statsUser1.wins, 1);
        assert.equal(statsUser1.losses, 0);

        const statsUser2 = getCategoryStats("medium", 3, { storage, userId: "dev_user_2" });
        assert.equal(statsUser2.gamesPlayed, 1);
        assert.equal(statsUser2.wins, 0);
        assert.equal(statsUser2.losses, 1);
    });

    test("4. Существующие старые данные (legacy) не удаляются и не повреждаются", () => {
        const storage = createMockStorage();
        const legacyMatch = {
            id: "legacy-ai-match",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "computer",
            boardSize: 3,
            difficulty: "easy",
            durationMs: 5000
        };

        // Запись в старое хранилище (без userId)
        addCompletedMatch(legacyMatch, { storage });
        assert.equal(getSavedMatches({ storage }).length, 1);

        // Запись новому изолированному пользователю
        const devMatch = {
            id: "dev-match-1",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "online",
            boardSize: 3,
            difficulty: "easy",
            durationMs: 7000
        };
        addCompletedMatch(devMatch, { storage, userId: "dev_user_1" });

        // Старые данные не тронуты
        const legacyAfter = getSavedMatches({ storage });
        assert.equal(legacyAfter.length, 1);
        assert.equal(legacyAfter[0].id, "legacy-ai-match");

        // Изолированные данные на месте
        const devAfter = getSavedMatches({ storage, userId: "dev_user_1" });
        assert.equal(devAfter.length, 1);
        assert.equal(devAfter[0].id, "dev-match-1");
    });

    test("5. Идемпотентность: повторный результат матча не учитывается дважды", () => {
        const storage = createMockStorage();
        const match = {
            id: "match-once-only",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "online",
            boardSize: 3,
            difficulty: "hard",
            durationMs: 9000
        };

        assert.equal(addCompletedMatch(match, { storage, userId: "dev_user_1" }), true);
        assert.equal(addCompletedMatch(match, { storage, userId: "dev_user_1" }), false);

        const stats = getCategoryStats("hard", 3, { storage, userId: "dev_user_1" });
        assert.equal(stats.gamesPlayed, 1);
        assert.equal(stats.wins, 1);
    });
});

describe("VK-003-006: Серверная статистика и сохранение в Cloudflare D1", () => {
    test("1. Сохранение победы: +25 победителю, -25 проигравшему", async () => {
        const mockD1 = createMockD1();
        const matchDO = createMockMatchDO("test-match-1", { DB: mockD1 });

        matchDO.matchId = "test-match-1";
        matchDO.boardSize = 3;
        matchDO.players = {
            X: { id: "dev_user_1", name: "Игрок 1", avatar: null },
            O: { id: "dev_user_2", name: "Игрок 2", avatar: null }
        };
        matchDO.movesHistory = [{ role: "X", index: 0 }, { role: "O", index: 1 }, { role: "X", index: 4 }];

        await matchDO.saveResultToD1("dev_user_1", "X", "win", 15000);

        // Проверяем match_history
        const { results: history } = await mockD1.prepare("SELECT * FROM match_history WHERE match_id = ?")
            .bind("test-match-1").all();
        assert.equal(history.length, 1);
        assert.equal(history[0].winner_id, "dev_user_1");
        assert.equal(history[0].win_reason, "win");
        assert.equal(history[0].duration_ms, 15000);

        // Проверяем leaderboards
        const { results: leaders } = await mockD1.prepare("SELECT * FROM leaderboards ORDER BY rating DESC").all();
        assert.equal(leaders.length, 2);

        const winner = leaders.find(l => l.vk_user_id === "dev_user_1");
        const loser = leaders.find(l => l.vk_user_id === "dev_user_2");

        assert.equal(winner.rating, 1025);
        assert.equal(winner.wins, 1);
        assert.equal(winner.losses, 0);
        assert.equal(winner.games_played, 1);
        assert.equal(winner.best_win_time_ms, 15000);

        assert.equal(loser.rating, 975);
        assert.equal(loser.wins, 0);
        assert.equal(loser.losses, 1);
        assert.equal(loser.games_played, 1);
    });

    test("2. Сохранение ничьей: +5 обоим игрокам, winner_id = NULL", async () => {
        const mockD1 = createMockD1();
        const matchDO = createMockMatchDO("test-match-draw", { DB: mockD1 });

        matchDO.matchId = "test-match-draw";
        matchDO.boardSize = 3;
        matchDO.players = {
            X: { id: "dev_user_1", name: "Игрок 1", avatar: null },
            O: { id: "dev_user_2", name: "Игрок 2", avatar: null }
        };
        matchDO.movesHistory = [{ role: "X", index: 0 }];

        await matchDO.saveResultToD1(null, "draw", "draw", 20000);

        const { results: history } = await mockD1.prepare("SELECT * FROM match_history WHERE match_id = ?")
            .bind("test-match-draw").all();
        assert.equal(history.length, 1);
        assert.equal(history[0].winner_id, null);
        assert.equal(history[0].win_reason, "draw");

        const { results: leaders } = await mockD1.prepare("SELECT * FROM leaderboards").all();
        for (const player of leaders) {
            assert.equal(player.rating, 1005);
            assert.equal(player.draws, 1);
            assert.equal(player.wins, 0);
            assert.equal(player.losses, 0);
            assert.equal(player.games_played, 1);
        }
    });

    test("3. Техническая победа при отключении (abandoned)", async () => {
        const mockD1 = createMockD1();
        const matchDO = createMockMatchDO("test-match-abandoned", { DB: mockD1 });

        matchDO.matchId = "test-match-abandoned";
        matchDO.boardSize = 3;
        matchDO.players = {
            X: { id: "dev_user_1", name: "Игрок 1", avatar: null },
            O: { id: "dev_user_2", name: "Игрок 2", avatar: null }
        };

        await matchDO.saveResultToD1("dev_user_1", "X", "abandoned", 35000);

        const { results: history } = await mockD1.prepare("SELECT * FROM match_history WHERE match_id = ?")
            .bind("test-match-abandoned").all();
        assert.equal(history[0].win_reason, "abandoned");
        assert.equal(history[0].winner_id, "dev_user_1");

        const { results: leaders } = await mockD1.prepare("SELECT * FROM leaderboards WHERE vk_user_id = ?")
            .bind("dev_user_1").all();
        assert.equal(leaders[0].rating, 1025);
    });

    test("4. Рейтинг игрока не может стать отрицательным (MAX(0, rating))", async () => {
        const mockD1 = createMockD1();
        const now = Date.now();

        // Создаем пользователя с рейтингом 10
        await mockD1.prepare("INSERT INTO users (vk_user_id, first_name, last_name, created_at, last_seen_at) VALUES ('weak_player', 'Player', '', ?, ?)")
            .bind(now, now).run();
        await mockD1.prepare("INSERT INTO leaderboards (vk_user_id, rating, games_played, wins, losses, draws, updated_at) VALUES ('weak_player', 10, 5, 0, 5, 0, ?)")
            .bind(now).run();

        const matchDO = createMockMatchDO("test-match-low", { DB: mockD1 });
        matchDO.matchId = "test-match-low";
        matchDO.boardSize = 3;
        matchDO.players = {
            X: { id: "dev_user_1", name: "Игрок 1", avatar: null },
            O: { id: "weak_player", name: "Player", avatar: null }
        };

        await matchDO.saveResultToD1("dev_user_1", "X", "win", 10000);

        const { results: leaders } = await mockD1.prepare("SELECT * FROM leaderboards WHERE vk_user_id = 'weak_player'").all();
        assert.equal(leaders[0].rating, 0); // 10 - 25 = -15 -> MAX(0, -15) = 0
    });

    test("5. Идемпотентность сохранения одного матча в D1", async () => {
        const mockD1 = createMockD1();
        const matchDO = createMockMatchDO("test-match-idem", { DB: mockD1 });

        matchDO.matchId = "test-match-idem";
        matchDO.boardSize = 3;
        matchDO.players = {
            X: { id: "dev_user_1", name: "Игрок 1", avatar: null },
            O: { id: "dev_user_2", name: "Игрок 2", avatar: null }
        };

        // Первое завершение матча
        await matchDO.saveResultToD1("dev_user_1", "X", "win", 8000);

        // Повторная попытка с тем же matchId (эмуляция дубля вызова или reconnect)
        await matchDO.saveResultToD1("dev_user_1", "X", "win", 8000);

        const { results: history } = await mockD1.prepare("SELECT * FROM match_history WHERE match_id = ?")
            .bind("test-match-idem").all();
        assert.equal(history.length, 1); // Дубликат в match_history не создан

        // Также проверяем, что finishMatch защищен флагом d1Saved
        matchDO.d1Saved = true;
        const savedBefore = (await mockD1.prepare("SELECT rating FROM leaderboards WHERE vk_user_id = 'dev_user_1'").all()).results[0].rating;
        await matchDO.finishMatch("X", "win");
        const savedAfter = (await mockD1.prepare("SELECT rating FROM leaderboards WHERE vk_user_id = 'dev_user_1'").all()).results[0].rating;
        assert.equal(savedBefore, savedAfter);
    });
});

describe("VK-003-006: API глобального рейтинга GET /api/leaderboard", () => {
    test("1. Пустая база возвращает пустой массив leaderboard", async () => {
        const mockD1 = createMockD1();
        const req = new Request("https://example.com/api/leaderboard", { method: "GET" });
        const res = await worker.fetch(req, { DB: mockD1 });
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.deepEqual(data.leaderboard, []);
    });

    test("2. Отсутствие D1 биндинга возвращает пустой массив без ошибки 500", async () => {
        const req = new Request("https://example.com/api/leaderboard", { method: "GET" });
        const res = await worker.fetch(req, {});
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.deepEqual(data.leaderboard, []);
    });

    test("3. Возвращает топ-10 игроков со стабильной сортировкой", async () => {
        const mockD1 = createMockD1();
        const now = Date.now();

        // Добавляем 15 пользователей с разным рейтингом
        for (let i = 1; i <= 15; i++) {
            const uid = `user_${i.toString().padStart(2, "0")}`;
            await mockD1.prepare("INSERT INTO users (vk_user_id, first_name, last_name, created_at, last_seen_at) VALUES (?, ?, '', ?, ?)")
                .bind(uid, `Игрок ${i}`, now, now).run();

            const rating = 1000 + i * 10;
            await mockD1.prepare("INSERT INTO leaderboards (vk_user_id, rating, games_played, wins, losses, draws, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?)")
                .bind(uid, rating, i, i, now).run();
        }

        const req = new Request("https://example.com/api/leaderboard", { method: "GET" });
        const res = await worker.fetch(req, { DB: mockD1 });
        assert.equal(res.status, 200);

        const { leaderboard } = await res.json();
        assert.equal(leaderboard.length, 10);

        // Первый элемент — с максимальным рейтингом (user_15, 1150)
        assert.equal(leaderboard[0].vk_user_id, "user_15");
        assert.equal(leaderboard[0].rating, 1150);
        assert.equal(leaderboard[0].first_name, "Игрок 15");

        // 10-й элемент — user_06 (1060)
        assert.equal(leaderboard[9].vk_user_id, "user_06");
        assert.equal(leaderboard[9].rating, 1060);
    });

    test("4. Одинаковый рейтинг сортируется детерминированно по победам и играм", async () => {
        const mockD1 = createMockD1();
        const now = Date.now();

        // Два игрока с одинаковым рейтингом 1050, но разным числом побед
        await mockD1.prepare("INSERT INTO users (vk_user_id, first_name, last_name, created_at, last_seen_at) VALUES ('p1', 'Player 1', '', ?, ?)")
            .bind(now, now).run();
        await mockD1.prepare("INSERT INTO users (vk_user_id, first_name, last_name, created_at, last_seen_at) VALUES ('p2', 'Player 2', '', ?, ?)")
            .bind(now, now).run();

        await mockD1.prepare("INSERT INTO leaderboards (vk_user_id, rating, games_played, wins, losses, draws, updated_at) VALUES ('p1', 1050, 4, 2, 2, 0, ?)")
            .bind(now).run();
        await mockD1.prepare("INSERT INTO leaderboards (vk_user_id, rating, games_played, wins, losses, draws, updated_at) VALUES ('p2', 1050, 3, 3, 0, 0, ?)")
            .bind(now).run();

        const req = new Request("https://example.com/api/leaderboard", { method: "GET" });
        const res = await worker.fetch(req, { DB: mockD1 });
        const { leaderboard } = await res.json();

        assert.equal(leaderboard[0].vk_user_id, "p2"); // Больше побед (3 против 2)
        assert.equal(leaderboard[1].vk_user_id, "p1");
    });

    test("5. POST /api/auth в Dev-режиме регистрирует dev_user_1 и dev_user_2 в D1 users", async () => {
        const mockD1 = createMockD1();
        const env = { DEV_MODE: "true", VK_CLIENT_SECRET: "secret", DB: mockD1 };

        const req1 = new Request("https://example.com/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ devUser: "dev_user_1" })
        });
        const res1 = await worker.fetch(req1, env);
        assert.equal(res1.status, 200);

        const req2 = new Request("https://example.com/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ devUser: "dev_user_2" })
        });
        const res2 = await worker.fetch(req2, env);
        assert.equal(res2.status, 200);

        const { results: users } = await mockD1.prepare("SELECT * FROM users ORDER BY vk_user_id").all();
        assert.equal(users.length, 2);
        assert.equal(users[0].vk_user_id, "dev_user_1");
        assert.equal(users[0].first_name, "Игрок 1 (Dev)");
        assert.equal(users[1].vk_user_id, "dev_user_2");
        assert.equal(users[1].first_name, "Игрок 2 (Dev)");
    });
});
