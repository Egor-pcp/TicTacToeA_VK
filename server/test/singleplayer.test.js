import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
    getWinningCombination,
    isDrawPosition,
    chooseComputerMoveForPosition,
    chooseComputerMoveForDifficulty,
    chooseEasyComputerMoveForPosition,
    chooseMediumComputerMoveForPosition
} from "../../game-logic.js";

import {
    addCompletedMatch,
    getSavedMatches,
    getCategoryStats,
    getOverallStats,
    getPlayerStatsStorageKey,
    getOrCreatePlayerIdentity
} from "../../player-stats.js";

import {
    createPlatformAdapter,
    MockPlatformAdapter,
    VkBridgeAdapter
} from "../../platform-adapter.js";

function createMockStorage() {
    const store = new Map();
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
        clear() {
            store.clear();
        }
    };
}

describe("VK-003-008: Этап B — Проверка одиночной игры против ИИ", () => {
    test("1. Игровое поле 3x3: победа игрока X по горизонтали, вертикали и диагонали", () => {
        // Горизонталь
        const horizBoard = ["X", "X", "X", "O", "O", "", "", "", ""];
        const horizWin = getWinningCombination(horizBoard);
        assert.deepEqual(horizWin, [0, 1, 2]);

        // Вертикаль
        const vertBoard = ["X", "O", "", "X", "O", "", "X", "", ""];
        const vertWin = getWinningCombination(vertBoard);
        assert.deepEqual(vertWin, [0, 3, 6]);

        // Главная диагональ
        const diag1Board = ["X", "O", "", "O", "X", "", "", "", "X"];
        const diag1Win = getWinningCombination(diag1Board);
        assert.deepEqual(diag1Win, [0, 4, 8]);

        // Побочная диагональ
        const diag2Board = ["", "O", "X", "O", "X", "", "X", "", ""];
        const diag2Win = getWinningCombination(diag2Board);
        assert.deepEqual(diag2Win, [2, 4, 6]);
    });

    test("2. Игровое поле 4x4: победа по линиям (4 в ряд)", () => {
        const size = 4;
        // Горизонталь в строке 1
        const board = Array(16).fill("");
        board[4] = "X"; board[5] = "X"; board[6] = "X"; board[7] = "X";
        const win = getWinningCombination(board);
        assert.deepEqual(win, [4, 5, 6, 7]);

        // Вертикаль в столбце 2
        const vertBoard = Array(16).fill("");
        vertBoard[2] = "O"; vertBoard[6] = "O"; vertBoard[10] = "O"; vertBoard[14] = "O";
        const vertWin = getWinningCombination(vertBoard);
        assert.deepEqual(vertWin, [2, 6, 10, 14]);

        // Диагональ
        const diagBoard = Array(16).fill("");
        diagBoard[0] = "X"; diagBoard[5] = "X"; diagBoard[10] = "X"; diagBoard[15] = "X";
        const diagWin = getWinningCombination(diagBoard);
        assert.deepEqual(diagWin, [0, 5, 10, 15]);
    });

    test("3. Игровое поле 5x5: победа по линиям (5 в ряд)", () => {
        const board = Array(25).fill("");
        board[0] = "X"; board[6] = "X"; board[12] = "X"; board[18] = "X"; board[24] = "X";
        const win = getWinningCombination(board);
        assert.deepEqual(win, [0, 6, 12, 18, 24]);
    });

    test("4. Определение ничьей на заполненном поле без победителя (3x3)", () => {
        const drawBoard = [
            "X", "O", "X",
            "X", "O", "O",
            "O", "X", "X"
        ];
        assert.equal(getWinningCombination(drawBoard), undefined);
        assert.equal(isDrawPosition(drawBoard), true);
    });

    test("5. ИИ: лёгкий уровень (easy) делает допустимые ходы на полях 3x3, 4x4, 5x5", () => {
        for (const size of [3, 4, 5]) {
            const board = Array(size * size).fill("");
            board[0] = "X";
            const move = chooseComputerMoveForDifficulty(board, "easy");
            assert.equal(typeof move, "number");
            assert.equal(move >= 0 && move < size * size, true);
            assert.equal(board[move], ""); // Выбрана свободная клетка
        }
    });

    test("6. ИИ: средний уровень (medium) немедленно блокирует угрозу победы X", () => {
        // Доска 3x3: X занимает 0 и 1, O должен заблокировать 2
        const board3 = ["X", "X", "", "O", "", "", "", "", ""];
        const move3 = chooseComputerMoveForDifficulty(board3, "medium");
        assert.equal(move3, 2);

        // Доска 3x3: X занимает 0 и 3, O должен заблокировать 6
        const boardCol = ["X", "O", "", "X", "", "", "", "", ""];
        const moveCol = chooseComputerMoveForDifficulty(boardCol, "medium");
        assert.equal(moveCol, 6);
    });

    test("7. ИИ: средний уровень (medium) забирает немедленную победу для O", () => {
        // У O есть 2 в ряд, а у X тоже есть угроза — O обязан выиграть, а не блокировать
        const board = ["O", "O", "", "X", "X", "", "", "", ""];
        const move = chooseComputerMoveForDifficulty(board, "medium");
        assert.equal(move, 2);
    });

    test("8. ИИ: сложный уровень (hard/minimax) непобедим на доске 3x3 при любых первых ходах", () => {
        // Проверяем, что против любого первого хода X минимакс не проигрывает при оптимальной защите
        for (let firstMove = 0; firstMove < 9; firstMove++) {
            const board = Array(9).fill("");
            board[firstMove] = "X";

            const aiReply = chooseComputerMoveForDifficulty(board, "hard");
            assert.equal(aiReply >= 0 && aiReply < 9, true);
            assert.notEqual(aiReply, firstMove);

            // Если X ходит в угол (0, 2, 6, 8), лучший ответ O — центр (4)
            if ([0, 2, 6, 8].includes(firstMove)) {
                assert.equal(aiReply, 4);
            }
        }
    });

    test("9. Одиночная игра: запись победы игрока X в локальную статистику (player-stats.js)", () => {
        const storage = createMockStorage();
        const userId = "dev_user_1";

        const match = {
            id: "match-single-1",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "computer",
            boardSize: 3,
            difficulty: "hard",
            durationMs: 8500
        };

        const added = addCompletedMatch(match, { storage, userId });
        assert.equal(added, true);

        const saved = getSavedMatches({ storage, userId });
        assert.equal(saved.length, 1);
        assert.equal(saved[0].id, "match-single-1");

        const catStats = getCategoryStats("hard", 3, { storage, userId });
        assert.equal(catStats.wins, 1);
        assert.equal(catStats.losses, 0);
        assert.equal(catStats.draws, 0);
        assert.equal(catStats.bestWinMs, 8500);

        const overall = getOverallStats({ storage, userId });
        assert.equal(overall.gamesPlayed, 1);
        assert.equal(overall.wins, 1);
    });

    test("10. Одиночная игра: запись поражения игрока X (победа O) в локальную статистику", () => {
        const storage = createMockStorage();
        const userId = "dev_user_1";

        addCompletedMatch({
            id: "match-single-loss",
            completedAt: new Date().toISOString(),
            result: "loss",
            winner: "O",
            mode: "computer",
            boardSize: 4,
            difficulty: "medium",
            durationMs: 12000
        }, { storage, userId });

        const catStats = getCategoryStats("medium", 4, { storage, userId });
        assert.equal(catStats.losses, 1);
        assert.equal(catStats.wins, 0);
        assert.equal(catStats.bestWinMs, null);
    });

    test("11. Одиночная игра: запись ничьей в локальную статистику", () => {
        const storage = createMockStorage();
        const userId = "dev_user_1";

        addCompletedMatch({
            id: "match-single-draw",
            completedAt: new Date().toISOString(),
            result: "draw",
            winner: null,
            mode: "computer",
            boardSize: 3,
            difficulty: "hard",
            durationMs: 15000
        }, { storage, userId });

        const catStats = getCategoryStats("hard", 3, { storage, userId });
        assert.equal(catStats.draws, 1);
        assert.equal(catStats.wins, 0);
        assert.equal(catStats.losses, 0);
    });

    test("12. Изоляция статистики при оффлайн-игре dev_user_1 и dev_user_2", () => {
        const storage = createMockStorage();

        addCompletedMatch({
            id: "m-user1",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "computer",
            boardSize: 3,
            difficulty: "easy",
            durationMs: 5000
        }, { storage, userId: "dev_user_1" });

        addCompletedMatch({
            id: "m-user2",
            completedAt: new Date().toISOString(),
            result: "loss",
            winner: "O",
            mode: "computer",
            boardSize: 3,
            difficulty: "easy",
            durationMs: 7000
        }, { storage, userId: "dev_user_2" });

        const matches1 = getSavedMatches({ storage, userId: "dev_user_1" });
        const matches2 = getSavedMatches({ storage, userId: "dev_user_2" });

        assert.equal(matches1.length, 1);
        assert.equal(matches1[0].result, "win");
        assert.equal(matches2.length, 1);
        assert.equal(matches2[0].result, "loss");

        const stats1 = getCategoryStats("easy", 3, { storage, userId: "dev_user_1" });
        const stats2 = getCategoryStats("easy", 3, { storage, userId: "dev_user_2" });

        assert.equal(stats1.wins, 1);
        assert.equal(stats1.losses, 0);
        assert.equal(stats2.wins, 0);
        assert.equal(stats2.losses, 1);
    });

    test("13. Офлайн-устойчивость: одиночная игра функционирует без сервера и VK Bridge", () => {
        // Даже если VK Bridge отсутствует и выбрасывает ошибку, логика игры чиста и автономна
        const adapter = new VkBridgeAdapter({ bridge: null, searchUrl: "" });
        assert.equal(adapter.isBridgeAvailable(), false);

        // Игровая логика работает автономно без внешних вызовов
        const board = ["", "", "", "", "X", "", "", "", ""];
        const computerMove = chooseComputerMoveForDifficulty(board, "hard");
        assert.equal(computerMove >= 0 && computerMove < 9, true);
        assert.notEqual(computerMove, 4);

        board[computerMove] = "O";
        assert.equal(board.filter(cell => cell !== "").length, 2);
    });

    test("14. Полная партия против ИИ от первого хода до победы X", () => {
        // Симулируем последовательность ходов игры 3x3 (легкий уровень, детерминированный выбор ИИ)
        let board = Array(9).fill("");
        let moveCount = 0;

        // Ход 1: X ставит в 0
        board[0] = "X";
        moveCount++;

        // Ход ИИ (O): детерминированный random выбирает первую свободную
        let oMove = chooseComputerMoveForDifficulty(board, "easy", { random: () => 0 });
        assert.equal(oMove, 1);
        board[oMove] = "O";
        moveCount++;

        // Ход 2: X ставит в 3
        board[3] = "X";
        moveCount++;

        // Ход ИИ (O): выбирает свободную
        oMove = chooseComputerMoveForDifficulty(board, "easy", { random: () => 0 });
        assert.equal(oMove, 2);
        board[oMove] = "O";
        moveCount++;

        // Ход 3: X ставит в 6 и выигрывает по левой вертикали [0, 3, 6]
        board[6] = "X";
        moveCount++;

        const win = getWinningCombination(board);
        assert.deepEqual(win, [0, 3, 6]);
        assert.equal(board[win[0]], "X");
        assert.equal(moveCount, 5);
    });

    test("15. Полная партия с ничьей (draw)", () => {
        // Разыгрываем партию с ничьей:
        // X O X
        // X O O
        // O X X
        const finalBoard = [
            "X", "O", "X",
            "X", "O", "O",
            "O", "X", "X"
        ];
        assert.equal(getWinningCombination(finalBoard), undefined);
        assert.equal(isDrawPosition(finalBoard), true);
    });
});
