
"use strict";

// Все выигрышные комбинации: строки, столбцы и диагонали.
const winningCombinationCache = new Map();

function getBoardSize(position) {
    return Math.sqrt(position.length);
}

function getWinningCombinations(size) {
    if (winningCombinationCache.has(size)) return winningCombinationCache.get(size);

    const combinations = [];
    for (let row = 0; row < size; row++) {
        combinations.push(Array.from({ length: size }, (_, col) => row * size + col));
    }
    for (let col = 0; col < size; col++) {
        combinations.push(Array.from({ length: size }, (_, row) => row * size + col));
    }
    combinations.push(Array.from({ length: size }, (_, index) => index * size + index));
    combinations.push(Array.from({ length: size }, (_, index) => index * size + size - 1 - index));

    winningCombinationCache.set(size, combinations);
    return combinations;
}

// Возвращает выигрышную комбинацию или undefined.
export function getWinningCombination(position) {
    const combinations = getWinningCombinations(getBoardSize(position));
    return combinations.find(combination =>
        position[combination[0]] !== "" &&
        combination.every(index => position[index] === position[combination[0]])
    );
}

// Определяет победителя: X, O или null.
function getWinner(position) {
    const combination = getWinningCombination(position);

    return combination ? position[combination[0]] : null;
}

// Проверяет ничью.
export function isDrawPosition(position) {
    return !getWinner(position) &&
        position.every(value => value !== "");
}

// Рекурсивно оценивает возможные продолжения партии.
function minimax(position, depth, isMaximizing) {
    const winner = getWinner(position);

    if (winner === "O") return 10 - depth;
    if (winner === "X") return depth - 10;

    if (position.every(value => value !== "")) {
        return 0;
    }

    if (isMaximizing) {
        let bestScore = -Infinity;

        for (let i = 0; i < position.length; i++) {
            if (position[i] !== "") continue;

            position[i] = "O";

            const score = minimax(position, depth + 1, false);

            position[i] = "";
            bestScore = Math.max(bestScore, score);
        }

        return bestScore;
    }

    let bestScore = Infinity;

    for (let i = 0; i < position.length; i++) {
        if (position[i] !== "") continue;

        position[i] = "X";

        const score = minimax(position, depth + 1, true);

        position[i] = "";
        bestScore = Math.min(bestScore, score);
    }

    return bestScore;
}

// Возвращает индекс лучшего хода для O.
// Полученный массив не изменяется.
export function chooseComputerMoveForPosition(currentBoard) {
    if (getBoardSize(currentBoard) > 3) {
        return chooseLargeBoardComputerMove(currentBoard, getBoardSize(currentBoard));
    }

    if (getWinner(currentBoard) ||
        currentBoard.every(value => value !== "")) {
        return -1;
    }

    const position = currentBoard.slice();
    let bestScore = -Infinity;
    let bestMoves = [];

    for (let i = 0; i < position.length; i++) {
        if (position[i] !== "") continue;

        position[i] = "O";

        const score = minimax(position, 0, false);

        position[i] = "";

        if (score > bestScore) {
            bestScore = score;
            bestMoves = [i];
        } else if (score === bestScore) {
            bestMoves.push(i);
        }
    }

    if (bestMoves.length === 0) {
        return -1;
    }

    return bestMoves[
        Math.floor(Math.random() * bestMoves.length)
    ];
}

function isTerminalPosition(position) {
    return Boolean(getWinner(position)) ||
        position.every(value => value !== "");
}

function getAvailableMoves(position) {
    return position
        .map((value, index) => value === "" ? index : -1)
        .filter(index => index !== -1);
}

function chooseRandomMove(moves, random) {
    if (moves.length === 0) return -1;
    return moves[Math.floor(random() * moves.length)];
}

function findImmediateWinningMove(position, player) {
    const nextPosition = position.slice();

    for (const move of getAvailableMoves(nextPosition)) {
        nextPosition[move] = player;
        const isWinningMove = getWinner(nextPosition) === player;
        nextPosition[move] = "";

        if (isWinningMove) return move;
    }

    return -1;
}

function countImmediateWinningMoves(position, player) {
    if (getWinner(position)) return 0;

    let winningMoves = 0;

    for (const move of getAvailableMoves(position)) {
        position[move] = player;
        if (getWinner(position) === player) winningMoves++;
        position[move] = "";
    }

    return winningMoves;
}

function allowsForkForPlayer(position, move, player) {
    const afterComputerMove = position.slice();
    afterComputerMove[move] = "O";

    for (const opponentMove of getAvailableMoves(afterComputerMove)) {
        afterComputerMove[opponentMove] = player;
        const playerCanWinImmediately = countImmediateWinningMoves(
            afterComputerMove,
            "O"
        ) > 0;
        const createsFork = !playerCanWinImmediately &&
            countImmediateWinningMoves(afterComputerMove, player) >= 2;
        afterComputerMove[opponentMove] = "";

        if (createsFork) return true;
    }

    return false;
}

function evaluateLargePosition(position, size) {
    const winner = getWinner(position);
    if (winner === "O") return 100000;
    if (winner === "X") return -100000;

    const weights = [0, 1, 8, 45, 250, 1500];
    let score = 0;
    for (const line of getWinningCombinations(size)) {
        let computerMarks = 0;
        let playerMarks = 0;
        for (const index of line) {
            if (position[index] === "O") computerMarks++;
            else if (position[index] === "X") playerMarks++;
        }
        if (computerMarks && playerMarks) continue;
        if (computerMarks) score += weights[computerMarks] || 1500;
        if (playerMarks) score -= (weights[playerMarks] || 1500) * 1.1;
    }
    return score;
}

function chooseLargeBoardComputerMove(position, size) {
    if (isTerminalPosition(position)) return -1;
    const available = getAvailableMoves(position);

    // Тактические ходы проверяются на всём поле до запуска ограниченного поиска.
    const winningMove = findImmediateWinningMove(position, "O");
    if (winningMove !== -1) return winningMove;
    const blockingMove = findImmediateWinningMove(position, "X");
    if (blockingMove !== -1) return blockingMove;

    const isNearMark = index => position.some((value, mark) => {
        if (value === "") return false;
        const rowDistance = Math.abs(Math.floor(index / size) - Math.floor(mark / size));
        const colDistance = Math.abs(index % size - mark % size);
        return Math.max(rowDistance, colDistance) <= 1;
    });
    let candidates = available.filter(isNearMark);
    if (candidates.length === 0) {
        const center = Math.floor(size / 2) * size + Math.floor(size / 2);
        return position[center] === "" ? center : available[0];
    }

    // Запасной ход выбирается до поиска, поэтому лимит никогда не оставит ИИ без хода.
    let bestMove = candidates[0];
    let bestScore = -Infinity;
    for (const move of candidates) {
        position[move] = "O";
        const score = evaluateLargePosition(position, size);
        position[move] = "";
        if (score > bestScore) {
            bestScore = score;
            bestMove = move;
        }
    }

    let visited = 0;
    const positionLimit = 3500;
    const searchDepth = size === 4 ? 3 : 2;

    function search(depth, maximizing, alpha, beta) {
        visited++;
        const winner = getWinner(position);
        if (winner || depth === 0 || visited >= positionLimit || position.every(Boolean)) {
            const evaluation = evaluateLargePosition(position, size);
            return evaluation + (winner === "O" ? depth : winner === "X" ? -depth : 0);
        }

        const side = maximizing ? "O" : "X";
        const opponent = maximizing ? "X" : "O";
        const moves = getAvailableMoves(position).filter(isNearMark);
        if (moves.length === 0) return evaluateLargePosition(position, size);

        const tacticalMove = findImmediateWinningMove(position, side);
        const blockingMove = tacticalMove === -1
            ? findImmediateWinningMove(position, opponent)
            : -1;
        const priorityMove = tacticalMove !== -1 ? tacticalMove : blockingMove;
        if (priorityMove !== -1 && !moves.includes(priorityMove)) {
            moves.unshift(priorityMove);
        } else if (priorityMove !== -1) {
            moves.splice(moves.indexOf(priorityMove), 1);
            moves.unshift(priorityMove);
        }

        let value = maximizing ? -Infinity : Infinity;
        for (const move of moves) {
            position[move] = side;
            const score = search(depth - 1, !maximizing, alpha, beta);
            position[move] = "";
            value = maximizing ? Math.max(value, score) : Math.min(value, score);
            if (maximizing) alpha = Math.max(alpha, value);
            else beta = Math.min(beta, value);
            if (beta <= alpha || visited >= positionLimit) break;
        }
        return value;
    }

    let searchedBestScore = -Infinity;
    for (const move of candidates) {
        if (visited >= positionLimit) break;
        position[move] = "O";
        const score = search(searchDepth - 1, false, -Infinity, Infinity);
        position[move] = "";
        if (score > searchedBestScore) {
            searchedBestScore = score;
            bestMove = move;
        }
    }
    return bestMove;
}

// Лёгкий уровень выбирает свободную клетку без тактических проверок.
export function chooseEasyComputerMoveForPosition(currentBoard, random = Math.random) {
    if (isTerminalPosition(currentBoard)) return -1;
    return chooseRandomMove(getAvailableMoves(currentBoard), random);
}

// Средний уровень видит ближайшую победу, угрозу и вилку в один ход.
export function chooseMediumComputerMoveForPosition(currentBoard, random = Math.random) {
    if (isTerminalPosition(currentBoard)) return -1;

    const winningMove = findImmediateWinningMove(currentBoard, "O");
    if (winningMove !== -1) return winningMove;

    const blockingMove = findImmediateWinningMove(currentBoard, "X");
    if (blockingMove !== -1) return blockingMove;

    const availableMoves = getAvailableMoves(currentBoard);
    if (getBoardSize(currentBoard) > 3) {
        const size = getBoardSize(currentBoard);
        const center = Math.floor(size / 2) * size + Math.floor(size / 2);
        if (availableMoves.includes(center)) return center;
        return chooseRandomMove(availableMoves, random);
    }

    const safeMoves = availableMoves.filter(move =>
        !allowsForkForPlayer(currentBoard, move, "X")
    );
    const strategicMoves = safeMoves.length > 0 ? safeMoves : availableMoves;

    if (strategicMoves.includes(4)) return 4;

    const corners = strategicMoves.filter(move => [0, 2, 6, 8].includes(move));
    if (corners.length > 0) return chooseRandomMove(corners, random);

    return chooseRandomMove(strategicMoves, random);
}

// Сложный уровень направляется в существующий minimax-выбор.
export function chooseComputerMoveForDifficulty(
    currentBoard,
    difficulty,
    { random = Math.random, hardMovePicker = chooseComputerMoveForPosition } = {}
) {
    if (difficulty === "easy") {
        return chooseEasyComputerMoveForPosition(currentBoard, random);
    }

    if (difficulty === "medium") {
        return chooseMediumComputerMoveForPosition(currentBoard, random);
    }

    return hardMovePicker(currentBoard);
}
