/**
 * Чистая серверная логика правил игры «Крестики-нолики».
 * Идентична клиентской логике game-logic.js для полной согласованности.
 */

const winningCombinationCache = new Map();

export function getWinningCombinations(size) {
    if (winningCombinationCache.has(size)) {
        return winningCombinationCache.get(size);
    }

    const combinations = [];
    // Горизонтали (строки)
    for (let row = 0; row < size; row++) {
        combinations.push(Array.from({ length: size }, (_, col) => row * size + col));
    }
    // Вертикали (столбцы)
    for (let col = 0; col < size; col++) {
        combinations.push(Array.from({ length: size }, (_, row) => row * size + col));
    }
    // Главная диагональ
    combinations.push(Array.from({ length: size }, (_, index) => index * size + index));
    // Побочная диагональ
    combinations.push(Array.from({ length: size }, (_, index) => index * size + size - 1 - index));

    winningCombinationCache.set(size, combinations);
    return combinations;
}

/**
 * Проверяет наличие выигрышной линии на доске.
 * @param {string[]} board - Массив ячеек ('', 'X', 'O').
 * @param {number} size - Размер стороны доски (3, 4, 5).
 * @returns {{ winner: "X" | "O", line: number[] } | null}
 */
export function findWinningLine(board, size) {
    const combinations = getWinningCombinations(size);
    for (const combination of combinations) {
        const first = board[combination[0]];
        if (first !== "" && combination.every(index => board[index] === first)) {
            return {
                winner: /** @type {"X" | "O"} */ (first),
                line: combination
            };
        }
    }
    return null;
}

/**
 * Проверяет ничью (нет пустых ячеек и нет победителя).
 * @param {string[]} board
 * @param {number} size
 * @returns {boolean}
 */
export function isDraw(board, size) {
    if (findWinningLine(board, size)) {
        return false;
    }
    return board.every(cell => cell !== "");
}

/**
 * Определяет текущий статус партии.
 * @param {string[]} board
 * @param {number} size
 * @returns {{ isOver: boolean, winner: "X" | "O" | "draw" | null, line?: number[] }}
 */
export function evaluateBoard(board, size) {
    const winResult = findWinningLine(board, size);
    if (winResult) {
        return {
            isOver: true,
            winner: winResult.winner,
            line: winResult.line
        };
    }

    if (board.every(cell => cell !== "")) {
        return {
            isOver: true,
            winner: "draw"
        };
    }

    return {
        isOver: false,
        winner: null
    };
}

/**
 * Проверяет валидность хода.
 * @param {string[]} board
 * @param {number} size
 * @param {number} index
 * @returns {{ isValid: boolean, reason?: string }}
 */
export function validateMove(board, size, index) {
    if (!Number.isInteger(index)) {
        return { isValid: false, reason: "Move index must be an integer" };
    }
    if (index < 0 || index >= size * size) {
        return { isValid: false, reason: "Move index out of board bounds" };
    }
    if (board[index] !== "") {
        return { isValid: false, reason: "Cell is already occupied" };
    }
    return { isValid: true };
}
