import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBoard, validateMove } from "../src/game-rules.js";

test("Правила 3x3: победа по горизонтали", () => {
    const board = [
        "X", "X", "X",
        "O", "O", "",
        "", "", ""
    ];
    const result = evaluateBoard(board, 3);
    assert.equal(result.isOver, true);
    assert.equal(result.winner, "X");
    assert.deepEqual(result.line, [0, 1, 2]);
});

test("Правила 3x3: победа по диагонали", () => {
    const board = [
        "O", "X", "",
        "X", "O", "",
        "", "X", "O"
    ];
    const result = evaluateBoard(board, 3);
    assert.equal(result.isOver, true);
    assert.equal(result.winner, "O");
    assert.deepEqual(result.line, [0, 4, 8]);
});

test("Правила 3x3: ничья", () => {
    const board = [
        "X", "O", "X",
        "X", "O", "O",
        "O", "X", "X"
    ];
    const result = evaluateBoard(board, 3);
    assert.equal(result.isOver, true);
    assert.equal(result.winner, "draw");
});

test("Правила 4x4: победа по вертикали", () => {
    const board = Array(16).fill("");
    board[1] = "X";
    board[5] = "X";
    board[9] = "X";
    board[13] = "X";
    const result = evaluateBoard(board, 4);
    assert.equal(result.isOver, true);
    assert.equal(result.winner, "X");
    assert.deepEqual(result.line, [1, 5, 9, 13]);
});

test("Валидация хода: отклонение занятой клетки и выхода за границы", () => {
    const board = ["X", "", "", "", "", "", "", "", ""];
    assert.equal(validateMove(board, 3, 0).isValid, false);
    assert.equal(validateMove(board, 3, 1).isValid, true);
    assert.equal(validateMove(board, 3, -1).isValid, false);
    assert.equal(validateMove(board, 3, 9).isValid, false);
});
