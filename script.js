
"use strict";

import {
    getWinningCombination,
    isDrawPosition,
    chooseComputerMoveForPosition,
    chooseComputerMoveForDifficulty
} from "./game-logic.js";
import {
    addCompletedMatch,
    getCategoryStats,
    getOrCreatePlayerId,
    getOrCreatePlayerIdentity
} from "./player-stats.js";
import { OnlineServerClient } from "./OnlineServerClient.js";
import { createPlatformAdapter, isVkMiniAppsMode } from "./platform-adapter.js";

let platformAdapter = null;
let lastAdShownAt = 0;
const AD_COOLDOWN_MS = 60000;

function getActiveUserId() {
    if (platformAdapter) {
        if (platformAdapter.mode === "vk_mini_apps") {
            const vkId = platformAdapter.getUserId();
            if (vkId) return vkId.startsWith("vk_") ? vkId : `vk_${vkId}`;
        }
        if (platformAdapter.mode === "development") {
            return platformAdapter.getUserId() || "dev_user_1";
        }
    }
    if (typeof window === "undefined") return "dev_user_1";
    const params = new URLSearchParams(window.location.search);
    const vkUserId = params.get("vk_user_id");
    if (vkUserId) return `vk_${vkUserId}`;
    return params.get("dev_user") || sessionStorage.getItem("tictactoe_dev_user") || "dev_user_1";
}

async function maybeShowInterstitialAd() {
    if (!platformAdapter) return;
    const now = Date.now();
    if (now - lastAdShownAt < AD_COOLDOWN_MS) {
        return;
    }
    lastAdShownAt = now;
    try {
        await platformAdapter.showNativeAds({ ad_format: "interstitial" });
    } catch (err) {
        console.warn("Native ad notice:", err?.message || err);
    }
}

window.addEventListener("tictactoe:match-completed", event => {
    const currentUserId = getActiveUserId();
    addCompletedMatch(event.detail, { userId: currentUserId });
    leaderboardDirty = true;
    renderStats();
    maybeShowInterstitialAd();
});

// Элементы интерфейса
let cells = [];
const boardElement = document.querySelector(".board");
const statusText = document.querySelector("#game-status");
const restartButton = document.querySelector(".restart");
const players = document.querySelectorAll(".player");
const turnTimerValues = [...document.querySelectorAll(".player-timer strong")];
const turnTimerLabels = [...document.querySelectorAll(".player-timer > span")];
const playerNames = [...document.querySelectorAll(".player-name")];
const playerStatuses = [...document.querySelectorAll(".player-status")];
const modeButtons = [...document.querySelectorAll(".mode-button")];
const matchTimeValue = document.querySelector(".match-time");
const previousResultValue = document.querySelector(".previous-result");
const statsGamesPlayedValue = document.querySelector("#stats-games-played");
const statsBestTimeValue = document.querySelector("#stats-best-time");
const statsRankValue = document.querySelector("#stats-rank");
const statsPlayerIdValue = document.querySelector("#stats-player-id");
const leaderboardRows = document.querySelector("#leaderboard-rows");

// Состояние текущей партии
let boardSize = 3;
let selectedBoardSize = boardSize;
let board = Array(boardSize * boardSize).fill("");
let currentPlayer = "X";
let gameOver = false;
let gameStarted = false;
let computerMoveTimer = null;
let selectedDifficulty = "medium";
let gameDifficulty = selectedDifficulty;
let statsFilterDifficulty = selectedDifficulty;
let statsFilterBoardSize = selectedBoardSize;
let timerDisplayInterval = null;
let previousMatchDurationMs = null;
let activeMatch = null;
let matchIdFallbackCounter = 0;
let gameMode = "computer";
let onlineState = "idle";
let onlineServerClient = null;
let onlineStartRequestId = 0;
let onlineStartPending = false;
let onlinePeerId = null;
let onlineErrorMessage = "";
let searchStartedAt = null;
let searchTimerInterval = null;
let onlinePracticeClockStarted = false;
let onlineMatch = null;
let onlineResultMessage = "";
let opponentDisconnectTimer = null;
let opponentDisconnectExpiresAt = null;
let isOpponentDisconnected = false;
let reconnectedMessageTimeout = null;

const ONLINE_GAME_PROTOCOL = "tictactoe-game-v1";
const ONLINE_BOARD_SIZES = new Set([3, 4, 5]);
const ONLINE_DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function createMatchId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    matchIdFallbackCounter += 1;
    const randomPart = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
        ? Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value.toString(16)).join("")
        : `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;

    return `match-${Date.now()}-${matchIdFallbackCounter}-${randomPart}`;
}

function createActiveMatch(mode = "computer", settings = {}) {
    return Object.freeze({
        id: settings.id ?? createMatchId(),
        mode,
        boardSize: settings.boardSize ?? boardSize,
        difficulty: settings.difficulty ?? gameDifficulty
    });
}

function createMatchResult(outcome, winner, durationMs) {
    if (!activeMatch) return null;

    return Object.freeze({
        id: activeMatch.id,
        completedAt: new Date().toISOString(),
        result: outcome,
        winner,
        mode: activeMatch.mode,
        boardSize: activeMatch.boardSize,
        difficulty: activeMatch.difficulty,
        durationMs
    });
}

function createTimerState(now = () => performance.now()) {
    let matchStartedAt = null;
    let matchStoppedAt = null;
    let activeTurn = null;
    let turnStartedAt = null;
    let turnDurations = { X: 0, O: 0 };

    function stopTurn(player, stoppedAt = now()) {
        if (activeTurn !== player || turnStartedAt === null) {
            return turnDurations[player] ?? 0;
        }
        turnDurations[player] = Math.max(0, stoppedAt - turnStartedAt);
        activeTurn = null;
        turnStartedAt = null;
        return turnDurations[player];
    }

    function startTurn(player, startedAt = now()) {
        activeTurn = player;
        turnStartedAt = startedAt;
        turnDurations[player] = 0;
    }

    return {
        startMatch(firstPlayer = "X") {
            const startedAt = now();
            matchStartedAt = startedAt;
            matchStoppedAt = null;
            turnDurations = { X: 0, O: 0 };
            if (firstPlayer === "X" || firstPlayer === "O") startTurn(firstPlayer, startedAt);
            else {
                activeTurn = null;
                turnStartedAt = null;
            }
        },
        startTurn,
        stopTurn,
        finish() {
            if (matchStartedAt === null) return 0;
            const stoppedAt = now();
            if (activeTurn !== null) stopTurn(activeTurn, stoppedAt);
            matchStoppedAt = stoppedAt;
            return Math.max(0, matchStoppedAt - matchStartedAt);
        },
        reset() {
            matchStartedAt = null;
            matchStoppedAt = null;
            activeTurn = null;
            turnStartedAt = null;
            turnDurations = { X: 0, O: 0 };
        },
        snapshot() {
            const currentTime = matchStoppedAt ?? now();
            const turns = { ...turnDurations };
            if (activeTurn !== null && turnStartedAt !== null) {
                turns[activeTurn] = Math.max(0, currentTime - turnStartedAt);
            }
            return {
                matchMs: matchStartedAt === null
                    ? 0
                    : Math.max(0, currentTime - matchStartedAt),
                turnMs: turns,
                activeTurn
            };
        }
    };
}

function roundToHundredths(milliseconds) {
    return Math.round(milliseconds / 10);
}

function compareMatchDurations(currentMs, previousMs) {
    if (previousMs === null) return "uncompared";
    const current = roundToHundredths(currentMs);
    const previous = roundToHundredths(previousMs);
    if (current < previous) return "faster";
    if (current > previous) return "slower";
    return "equal";
}

const timerState = createTimerState();

function formatElapsed(milliseconds) {
    const seconds = roundToHundredths(milliseconds) / 100;
    return `${new Intl.NumberFormat("ru-RU", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(seconds)} с`;
}

function updateStatsFilterButtons() {
    document.querySelectorAll("[data-stats-filter-difficulty]").forEach(button => {
        const isSelected = button.dataset.statsFilterDifficulty === statsFilterDifficulty;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", String(isSelected));
    });
    document.querySelectorAll("[data-stats-filter-board-size]").forEach(button => {
        const isSelected = Number(button.dataset.statsFilterBoardSize) === statsFilterBoardSize;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", String(isSelected));
    });
}

function syncStatsFiltersFromGameSettings() {
    statsFilterDifficulty = selectedDifficulty;
    statsFilterBoardSize = selectedBoardSize;
    updateStatsFilterButtons();
}

let leaderboardCache = null;
let leaderboardInFlightPromise = null;
let leaderboardDirty = true;
let leaderboardFetchError = false;

function getServerUrl() {
    if (typeof window !== "undefined") {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get("server")) return urlParams.get("server");
        if (window.TICTACTOE_ONLINE_CONFIG?.serverUrl) return window.TICTACTOE_ONLINE_CONFIG.serverUrl;
        const hostname = window.location.hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1" || !hostname) {
            return "http://localhost:8787";
        }
    }
    return "https://tictactoe-vk-server.egorpcp.workers.dev";
}

async function fetchLeaderboard({ force = false } = {}) {
    if (!force && !leaderboardDirty && leaderboardCache) {
        return leaderboardCache;
    }

    if (leaderboardInFlightPromise) {
        return leaderboardInFlightPromise;
    }

    leaderboardInFlightPromise = (async () => {
        try {
            const serverUrl = getServerUrl();
            const res = await fetch(`${serverUrl}/api/leaderboard`, { method: "GET" });
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            const data = await res.json();
            const list = Array.isArray(data.leaderboard) ? data.leaderboard : [];
            leaderboardCache = list;
            leaderboardDirty = false;
            leaderboardFetchError = false;
            return list;
        } catch (err) {
            console.warn("Failed to load leaderboard:", err);
            leaderboardFetchError = true;
            throw err;
        } finally {
            leaderboardInFlightPromise = null;
        }
    })();

    return leaderboardInFlightPromise;
}

function renderLeaderboard(list, currentUserId) {
    if (!leaderboardRows) return;
    leaderboardRows.replaceChildren();

    if (leaderboardFetchError && (!list || list.length === 0)) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "leaderboard-status-cell";
        cell.innerHTML = `Не удалось загрузить рейтинг. <button type="button" class="leaderboard-retry-btn" id="retry-leaderboard-btn">Повторить</button>`;
        row.append(cell);
        leaderboardRows.append(row);
        document.querySelector("#retry-leaderboard-btn")?.addEventListener("click", () => {
            loadAndRenderLeaderboard(true);
        });
        return;
    }

    if (!list || list.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "leaderboard-status-cell";
        cell.textContent = "Рейтинг пока пуст. Сыграйте первый матч!";
        row.append(cell);
        leaderboardRows.append(row);
        return;
    }

    const medals = ["🥇 1", "🥈 2", "🥉 3"];
    const topRows = list.slice(0, 10);

    topRows.forEach((item, index) => {
        const row = document.createElement("tr");
        const isCurrentUser = (item.vk_user_id === currentUserId) ||
            (currentUserId === "dev_user_1" && item.vk_user_id === "dev_user_1") ||
            (currentUserId === "dev_user_2" && item.vk_user_id === "dev_user_2") ||
            (currentUserId === `vk_${item.vk_user_id}`);

        if (index === 0) row.classList.add("leaderboard-top-1");
        else if (index === 1) row.classList.add("leaderboard-top-2");
        else if (index === 2) row.classList.add("leaderboard-top-3");

        if (isCurrentUser) {
            row.classList.add("leaderboard-current-user");
        }

        const placeCell = document.createElement("td");
        placeCell.textContent = index < 3 ? medals[index] : String(index + 1);

        const nameCell = document.createElement("td");
        const userWrap = document.createElement("span");
        userWrap.className = "leaderboard-user-cell";

        if (item.avatar_url) {
            const avatarImg = document.createElement("img");
            avatarImg.className = "leaderboard-avatar";
            avatarImg.src = item.avatar_url;
            avatarImg.alt = "";
            avatarImg.loading = "lazy";
            userWrap.append(avatarImg);
        }

        const nameSpan = document.createElement("span");
        let displayName = item.first_name || "";
        if (item.last_name) displayName += ` ${item.last_name}`;
        if (!displayName.trim()) {
            displayName = item.vk_user_id === "dev_user_1" ? "Игрок 1 (Dev)" :
                item.vk_user_id === "dev_user_2" ? "Игрок 2 (Dev)" :
                `Игрок ${String(item.vk_user_id).slice(-4)}`;
        }
        nameSpan.textContent = displayName;
        userWrap.append(nameSpan);
        nameCell.append(userWrap);

        const ratingCell = document.createElement("td");
        ratingCell.textContent = String(item.rating ?? 1000);

        row.append(placeCell, nameCell, ratingCell);
        leaderboardRows.append(row);
    });
}

async function loadAndRenderLeaderboard(force = false) {
    if (!leaderboardRows) return;
    const currentUserId = getActiveUserId();

    if ((force || leaderboardDirty || !leaderboardCache) && (!leaderboardCache || leaderboardCache.length === 0)) {
        leaderboardRows.replaceChildren();
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 3;
        cell.className = "leaderboard-status-cell";
        cell.textContent = "Загрузка рейтинга…";
        row.append(cell);
        leaderboardRows.append(row);
    }

    try {
        const list = await fetchLeaderboard({ force });
        renderLeaderboard(list, currentUserId);

        if (statsRankValue) {
            const userIndex = list.findIndex(item =>
                item.vk_user_id === currentUserId ||
                (currentUserId === "dev_user_1" && item.vk_user_id === "dev_user_1") ||
                (currentUserId === "dev_user_2" && item.vk_user_id === "dev_user_2") ||
                currentUserId === `vk_${item.vk_user_id}`
            );
            statsRankValue.textContent = userIndex !== -1 ? String(userIndex + 1) : "—";
        }
    } catch {
        renderLeaderboard(leaderboardCache, currentUserId);
        if (statsRankValue) statsRankValue.textContent = "—";
    }
}

function renderStats() {
    const currentUserId = getActiveUserId();
    const stats = getCategoryStats(statsFilterDifficulty, statsFilterBoardSize, { userId: currentUserId });
    if (statsGamesPlayedValue) statsGamesPlayedValue.textContent = String(stats.gamesPlayed);
    if (statsBestTimeValue) statsBestTimeValue.textContent = stats.bestWinMs === null
        ? "—"
        : formatElapsed(stats.bestWinMs);
    const identity = getOrCreatePlayerIdentity({ userId: currentUserId });
    if (statsPlayerIdValue) statsPlayerIdValue.textContent = identity.displayId;

    loadAndRenderLeaderboard();
}

document.querySelectorAll("[data-stats-filter-difficulty], [data-stats-filter-board-size]").forEach(button => {
    button.addEventListener("click", () => {
        if (button.hasAttribute("data-stats-filter-difficulty")) {
            statsFilterDifficulty = button.dataset.statsFilterDifficulty;
        } else {
            statsFilterBoardSize = Number(button.dataset.statsFilterBoardSize);
        }
        updateStatsFilterButtons();
        renderStats();
    });
});

updateStatsFilterButtons();
renderStats();

function updateTimerDisplay() {
    const snapshot = timerState.snapshot();
    turnTimerValues.forEach((value, index) => {
        value.textContent = formatElapsed(snapshot.turnMs[index === 0 ? "X" : "O"]);
    });

    if (gameMode === "online" && onlineState === "searching") {
        turnTimerValues[0].textContent = "—";
        turnTimerValues[1].textContent = formatSearchElapsed();
    } else if (gameMode === "online") {
        turnTimerValues.forEach((value, index) => {
            const side = index === 0 ? "X" : "O";
            if (!onlineMatch?.started || onlineMatch.localSide !== side) value.textContent = "—";
        });
    }

    matchTimeValue.textContent = formatElapsed(snapshot.matchMs);
}

function formatSearchElapsed() {
    if (searchStartedAt === null) return "00:00:00";

    const totalSeconds = Math.floor(Math.max(0, performance.now() - searchStartedAt) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
        .map(value => String(value).padStart(2, "0"))
        .join(":");
}

function startSearchTimer() {
    if (searchStartedAt !== null) return;

    searchStartedAt = performance.now();
    stopTimerDisplay();
    updateTimerDisplay();
    searchTimerInterval = setInterval(updateTimerDisplay, 250);
}

function startOnlinePracticeClock() {
    onlinePracticeClockStarted = true;
    resetMatchTimers(null);
}

function stopSearchTimer() {
    if (searchTimerInterval !== null) {
        clearInterval(searchTimerInterval);
        searchTimerInterval = null;
    }
    searchStartedAt = null;
    updateTimerDisplay();
}

function updateModeButtons() {
    modeButtons.forEach(button => {
        const isSelected = button.dataset.mode === gameMode;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", String(isSelected));
    });
}

function updateOnlinePlayerCard() {
    const rightPlayer = players[1];
    const isSearching = gameMode === "online" && onlineState === "searching";
    const hasOnlineMatch = gameMode === "online" && onlineMatch !== null;
    const isOnlineMatch = gameMode === "online" && onlineMatch?.started;
    rightPlayer.classList.toggle("is-searching", isSearching);
    if (gameMode === "online") {
        playerNames[0].textContent = hasOnlineMatch && onlineMatch.localSide !== "X"
            ? `${onlinePeerId ?? "Соперник"} — X`
            : "Ты — X";
        playerNames[1].textContent = isSearching
            ? "Поиск игрока"
            : hasOnlineMatch && onlineMatch.localSide === "O"
                ? "Ты — O"
                : onlinePeerId ?? "Соперник — O";
    } else {
        playerNames[0].textContent = "Ты — X";
        playerNames[1].textContent = "Компьютер — O";
    }
    playerNames[1].title = onlinePeerId ?? "";
    turnTimerLabels[1].textContent = isSearching ? "Время поиска" : "Время хода";

    if (gameMode !== "online") {
        playerStatuses[1].textContent = gameOver ? "Партия завершена" : "Ожидание";
    } else if (isOnlineMatch && !gameOver) {
        playerStatuses[1].textContent = onlineMatch.localSide === "O"
            ? currentPlayer === "O" ? "Твой ход" : "Ожидание"
            : currentPlayer === "O" ? "Ход соперника" : "Ожидание";
    } else if (onlineState === "searching") {
        playerStatuses[1].textContent = "Ожидание";
    } else if (onlineState === "connecting") {
        playerStatuses[1].textContent = "Подключение...";
    } else if (onlineState === "ready") {
        playerStatuses[1].textContent = "Ожидание матча";
    } else if (onlineState === "error") {
        playerStatuses[1].textContent = "Ошибка";
    } else {
        playerStatuses[1].textContent = "Ожидание";
    }
}

function renderPreviousResult() {
    previousResultValue.textContent = previousMatchDurationMs === null
        ? "Предыдущий результат: —"
        : `Предыдущий результат: ${formatElapsed(previousMatchDurationMs)}`;
}

function renderFinishedResult(durationMs) {
    renderPreviousResult();
    matchTimeValue.classList.remove(
        "result-faster",
        "result-slower",
        "result-equal",
        "result-neutral",
        "result-uncompared"
    );
    matchTimeValue.classList.add(`result-${compareMatchDurations(durationMs, previousMatchDurationMs)}`);
    previousMatchDurationMs = durationMs;
}

function startTimerDisplay() {
    if (timerDisplayInterval !== null) return;
    timerDisplayInterval = setInterval(updateTimerDisplay, 25);
}

function stopTimerDisplay() {
    if (timerDisplayInterval === null) return;
    clearInterval(timerDisplayInterval);
    timerDisplayInterval = null;
}

function resetMatchTimers(firstPlayer = "X") {
    stopTimerDisplay();
    timerState.reset();
    timerState.startMatch(firstPlayer);
    matchTimeValue.classList.remove(
        "result-faster",
        "result-slower",
        "result-equal",
        "result-uncompared"
    );
    matchTimeValue.classList.add("result-neutral");
    renderPreviousResult();
    updateTimerDisplay();
    startTimerDisplay();
}

function renderBoard() {
    boardElement.dataset.size = String(boardSize);
    boardElement.replaceChildren();
    cells = [];

    for (let index = 0; index < boardSize * boardSize; index++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cell";
        cell.dataset.index = String(index);
        cell.setAttribute("aria-label", `Клетка ${index + 1}`);
        cell.addEventListener("click", handleCellClick);
        cells.push(cell);
        boardElement.append(cell);
    }
}

// Обновляем надписи и подсветку активного игрока.
function updateInterface() {
    const onlinePractice = gameMode === "online" && onlineState === "searching";
    const onlineMessages = {
        searching: "Поиск игрока, а пока сыграй сам с собой.",
        connecting: "Игрок найден! Устанавливаем соединение…",
        ready: gameOver && onlineResultMessage
            ? onlineResultMessage
            : onlineMatch?.localRematchRequested && !onlineMatch?.peerRematchRequested
                ? "Реванш запрошен. Ожидаем соперника."
                : onlineMatch?.peerRematchRequested && !onlineMatch?.localRematchRequested
                    ? "Соперник предлагает реванш."
                    : onlineMatch?.started
                        ? currentPlayer === onlineMatch.localSide ? "Твой ход" : "Ход соперника"
                        : "Соединение установлено. Готовимся к матчу…",
        error: onlineErrorMessage || "Не удалось подключиться. Попробуй начать поиск снова."
    };

    if (gameMode === "online") {
        if (reconnectedMessageTimeout) {
            statusText.textContent = "Соперник вернулся! Игра продолжается.";
        } else if (isOpponentDisconnected && opponentDisconnectExpiresAt) {
            const sec = Math.max(0, Math.ceil((opponentDisconnectExpiresAt - Date.now()) / 1000));
            statusText.textContent = `Соперник отключился. Ожидаем возвращения: ${sec} сек.`;
        } else {
            statusText.textContent = onlineMessages[onlineState] ?? "Поиск игрока";
        }
    } else if (!gameOver) {
        statusText.textContent = gameStarted
            ? currentPlayer === "X" ? "Твой ход" : "Ход компьютера"
            : "Нажмите «Начать игру»";
    }
    statusText.classList.toggle("is-online-searching", onlinePractice);

    if (gameMode === "online") {
        if (onlineState === "searching") {
            restartButton.textContent = "✕ Отменить поиск";
            restartButton.disabled = false;
        } else if (gameOver) {
            restartButton.textContent = "🔍 Новый поиск";
            restartButton.disabled = false;
        } else {
            restartButton.textContent = "В игре";
            restartButton.disabled = true;
        }
    } else {
        restartButton.textContent = gameStarted || gameOver ? "↻ Новая игра" : "Начать игру";
        restartButton.disabled = false;
    }

    players.forEach((player, index) => {
        const isActive =
            gameStarted &&
            !gameOver &&
            (gameMode === "computer"
                ? (index === 0 && currentPlayer === "X") ||
                    (index === 1 && currentPlayer === "O")
                : onlinePractice && ((index === 0 && currentPlayer === "X") ||
                    (index === 1 && currentPlayer === "O")) ||
                    (onlineMatch?.started && onlineMatch.localSide === (index === 0 ? "X" : "O") &&
                        currentPlayer === onlineMatch.localSide));

        player.classList.toggle("active", isActive);

        if (index === 1 && gameMode === "online") return;
        playerStatuses[index].textContent = onlinePractice
            ? isActive ? "Твой ход" : "Ожидание"
            : gameOver
                ? "Партия завершена"
                : !gameStarted
                    ? "Ожидание"
                    : isActive
                        ? (index === 0 ? "Твой ход" : "Думает...")
                        : "Ожидание";
    });

    cells.forEach(cell => {
        cell.disabled = gameMode === "online" && !onlinePractice &&
            !(onlineMatch?.started && onlineState === "ready" && !gameOver && !isOpponentDisconnected &&
                currentPlayer === onlineMatch.localSide);
    });
    updateModeButtons();
    updateOnlinePlayerCard();
}

// Завершаем партию и подсвечиваем победную комбинацию.
function finishGame(message, outcome, winner = null, winningCombination = [], { broadcastOnline = true } = {}) {
    const isOnlinePractice = gameMode === "online" && onlineState === "searching";
    if (gameOver || (!activeMatch && !isOnlinePractice)) return;

    console.log(`Игра завершена: ${message}`);
    gameOver = true;
    statusText.textContent = message;
    const finalMatchDuration = timerState.finish();
    if (isOnlinePractice) onlinePracticeClockStarted = false;
    const matchSnapshot = activeMatch;
    const playerOutcome = matchSnapshot?.mode === "online"
        ? winner === null ? "draw" : winner === onlineMatch?.localSide ? "win" : "loss"
        : outcome;
    const matchResult = matchSnapshot
        ? createMatchResult(playerOutcome, winner, finalMatchDuration)
        : null;
    if (matchSnapshot?.mode === "online" && onlineMatch?.started) {
        onlineMatch.completed = true;
        onlineMatch.winner = winner;
        onlineMatch.outcome = playerOutcome;
        onlineResultMessage = message;
        if (broadcastOnline) {
            try {
                sendOnlinePacket("game-over", {
                    gameId: onlineMatch.gameId,
                    round: onlineMatch.round,
                    sequence: onlineMatch.moveNumber,
                    winner,
                    result: playerOutcome
                });
            } catch (error) {
                console.error("Не удалось отправить итог онлайн-партии", error);
            }
        }
    }
    activeMatch = null;
    if (matchResult) {
        window.dispatchEvent(new CustomEvent("tictactoe:match-completed", {
            detail: matchResult
        }));
    }
    stopTimerDisplay();
    updateTimerDisplay();
    if (matchResult || isOnlinePractice) renderFinishedResult(finalMatchDuration);

    winningCombination.forEach(position => {
        cells[position].classList.add("winning");
    });

    updateInterface();
}

// Отображаем ход и обновляем состояние поля.
function showMove(index, player) {
    board[index] = player;
    cells[index].textContent = player;

    cells[index].classList.add(
        player === "X" ? "mark-x" : "mark-o"
    );
}

// Обрабатываем ход человека.
function handleCellClick(event) {
    const index = Number(event.currentTarget.dataset.index);
    const isOnlinePractice = gameMode === "online" && onlineState === "searching";
    const isOnlineMatch = gameMode === "online" && onlineState === "ready" && onlineMatch?.started && !isOpponentDisconnected;

    if (gameOver || (gameMode === "computer" && currentPlayer !== "X") ||
        (gameMode === "online" && !isOnlinePractice && !isOnlineMatch) ||
        (isOnlineMatch && currentPlayer !== onlineMatch.localSide)) return;
    if (board[index] !== "") return;

    if (isOnlineMatch) {
        if (currentPlayer !== onlineMatch.localSide) {
            return;
        }
        try {
            onlineServerClient.makeMove(index);
            cells[index].disabled = true;
        } catch (error) {
            console.error("Не удалось отправить ход на сервер:", error);
        }
        return;
    }

    if (!gameStarted) startGame();

    const movedPlayer = currentPlayer;
    timerState.stopTurn(movedPlayer);
    showMove(index, movedPlayer);
    console.log(`Ход ${movedPlayer}: клетка ${index + 1}`);

    const winningCombination = getWinningCombination(board);

    if (winningCombination) {
        const winMessage = isOnlinePractice
            ? `Победил ${movedPlayer}`
            : "Ты победил!";
        finishGame(winMessage, "win", movedPlayer, winningCombination);
        return;
    }

    if (isDrawPosition(board)) {
        finishGame("Ничья!", "draw");
        return;
    }

    if (isOnlinePractice) {
        currentPlayer = movedPlayer === "X" ? "O" : "X";
        updateInterface();
        updateTimerDisplay();
        return;
    }

    currentPlayer = "O";
    timerState.startTurn("O");
    updateInterface();
    updateTimerDisplay();
    computerMoveTimer = setTimeout(makeComputerMove, 350);
    console.log("Таймер компьютера установлен");
}

function applyOnlineMove(index, player, fromPeer) {
    timerState.stopTurn(player);
    showMove(index, player);
    console.log(`Ход ${player}: клетка ${index + 1}`);
    const winningCombination = getWinningCombination(board);
    if (winningCombination) {
        const wonByLocalPlayer = player === onlineMatch.localSide;
        finishGame(wonByLocalPlayer ? "Ты победил!" : "Победил соперник", "win", player,
            winningCombination, { broadcastOnline: !fromPeer });
        return;
    }
    if (isDrawPosition(board)) {
        finishGame("Ничья!", "draw", null, [], { broadcastOnline: !fromPeer });
        return;
    }

    currentPlayer = player === "X" ? "O" : "X";
    if (currentPlayer === onlineMatch.localSide) timerState.startTurn(currentPlayer);
    updateInterface();
    updateTimerDisplay();
}

// Выполняем ход компьютера.
function makeComputerMove() {
    computerMoveTimer = null;

    if (gameOver || gameMode !== "computer" || currentPlayer !== "O") return;
    console.log("Компьютер думает");

    const index = chooseComputerMoveForDifficulty(board, gameDifficulty);

    if (index === -1) return;

    showMove(index, "O");
    timerState.stopTurn("O");
    console.log(`Ход O: клетка ${index + 1}`);

    const winningCombination = getWinningCombination(board);

    if (winningCombination) {
        finishGame("Компьютер победил!", "loss", "O", winningCombination);
        return;
    }

    if (isDrawPosition(board)) {
        finishGame("Ничья!", "draw");
        return;
    }

    currentPlayer = "X";
    timerState.startTurn("X");
    updateInterface();
    updateTimerDisplay();
}

// Начинаем новую партию.
function applySelectedDifficultyToNewGame() {
    gameDifficulty = selectedDifficulty;
    return gameDifficulty;
}

function applySelectedBoardSizeToNewGame() {
    boardSize = selectedBoardSize;
    board = Array(boardSize * boardSize).fill("");
    return boardSize;
}

function cancelComputerMoveTimer() {
    if (computerMoveTimer === null) return;
    clearTimeout(computerMoveTimer);
    computerMoveTimer = null;
    console.log("Ожидающий таймер компьютера отменён");
}

function prepareOnlineSearch() {
    cancelComputerMoveTimer();
    applySelectedBoardSizeToNewGame();
    applySelectedDifficultyToNewGame();
    currentPlayer = "X";
    gameOver = false;
    gameStarted = false;
    activeMatch = null;
    onlinePracticeClockStarted = false;
    stopTimerDisplay();
    timerState.reset();
    matchTimeValue.classList.remove(
        "result-faster",
        "result-slower",
        "result-equal",
        "result-uncompared"
    );
    matchTimeValue.classList.add("result-neutral");
    renderPreviousResult();
    renderBoard();
    updateTimerDisplay();
}

function pauseUntrackedOnlineGame() {
    if (gameMode !== "online" || activeMatch === null) {
        gameStarted = false;
        currentPlayer = "X";
        stopTimerDisplay();
        timerState.reset();
    }
}

function isCloudflareQuotaError(message, error) {
    if (Number(error?.code) === 1027 || Number(error?.status) === 1027) return true;
    return /\b(?:cloudflare\s+)?error\s*1027\b/i.test(String(message ?? error?.message ?? ""));
}

function handleOnlineError(message, error) {
    stopSearchTimer();
    const interruptedMatch = abandonActiveOnlineMatch();
    onlineState = "error";
    onlineErrorMessage = isCloudflareQuotaError(message, error)
        ? "Лимит на сегодня исчерпан"
        : "Онлайн временно недоступен";
    if (!interruptedMatch && !onlineMatch?.completed) pauseUntrackedOnlineGame();
    updateInterface();
    updateTimerDisplay();
}







function abandonActiveOnlineMatch() {
    if (activeMatch?.mode !== "online") return false;
    timerState.finish();
    activeMatch = null;
    gameStarted = false;
    gameOver = true;
    if (onlineMatch) onlineMatch.started = false;
    stopTimerDisplay();
    return true;
}

function stopDisconnectCountdown() {
    if (opponentDisconnectTimer) {
        clearInterval(opponentDisconnectTimer);
        opponentDisconnectTimer = null;
    }
    opponentDisconnectExpiresAt = null;
}

function handleOpponentDisconnected(data = {}) {
    if (gameOver) return;

    stopDisconnectCountdown();
    if (reconnectedMessageTimeout) {
        clearTimeout(reconnectedMessageTimeout);
        reconnectedMessageTimeout = null;
    }

    isOpponentDisconnected = true;

    const graceMs = typeof data.remainingGraceMs === "number"
        ? data.remainingGraceMs
        : (typeof data.gracePeriodMs === "number" ? data.gracePeriodMs : 15000);

    opponentDisconnectExpiresAt = data.expiresAt || (Date.now() + graceMs);

    function getRemainingSeconds() {
        if (!opponentDisconnectExpiresAt) return 0;
        return Math.max(0, Math.ceil((opponentDisconnectExpiresAt - Date.now()) / 1000));
    }

    function renderCountdown() {
        const sec = getRemainingSeconds();
        statusText.textContent = `Соперник отключился. Ожидаем возвращения: ${sec} сек.`;
    }

    renderCountdown();
    updateInterface();

    opponentDisconnectTimer = setInterval(() => {
        const sec = getRemainingSeconds();
        renderCountdown();
    }, 1000);
}

function handleOpponentReconnected() {
    if (gameOver) return;

    stopDisconnectCountdown();
    isOpponentDisconnected = false;

    statusText.textContent = "Соперник вернулся! Игра продолжается.";
    updateInterface();

    if (reconnectedMessageTimeout) clearTimeout(reconnectedMessageTimeout);
    reconnectedMessageTimeout = setTimeout(() => {
        reconnectedMessageTimeout = null;
        if (!gameOver && onlineMatch?.started) {
            updateInterface();
        }
    }, 2500);
}

function setupOnlineClientListeners(client, requestId) {
    const isCurrentClient = () => onlineServerClient === client && requestId === onlineStartRequestId;

    client.on("searching", () => {
        if (!isCurrentClient()) return;
        stopDisconnectCountdown();
        isOpponentDisconnected = false;
        onlineState = "searching";
        startSearchTimer();
        updateInterface();
        updateTimerDisplay();
    });

    client.on("match_start", data => {
        if (!isCurrentClient()) return;
        stopDisconnectCountdown();
        isOpponentDisconnected = false;
        stopSearchTimer();
        onlinePeerId = data.opponent?.name || `Игрок ${data.opponent?.id?.slice(-4) || ""}`;
        onlineState = "connecting";
        startTimerDisplay();
        updateInterface();
        updateTimerDisplay();
    });

    client.on("snapshot", snapshot => {
        if (!isCurrentClient()) return;
        onlineState = "ready";
        onlinePeerId = snapshot.opponent?.name || `Игрок ${snapshot.opponent?.id?.slice(-4) || ""}`;

        boardSize = snapshot.boardSize;
        board = [...snapshot.board];
        renderBoard();

        board.forEach((mark, idx) => {
            if (mark) {
                cells[idx].textContent = mark;
                cells[idx].disabled = true;
                cells[idx].classList.add(mark === "X" ? "mark-x" : "mark-o");
            }
        });

        onlineMatch = {
            matchId: snapshot.matchId,
            localSide: snapshot.role,
            started: true,
            completed: snapshot.status === "completed",
            opponentName: onlinePeerId
        };

        currentPlayer = snapshot.turn;
        gameOver = snapshot.status === "completed";
        gameStarted = true;
        activeMatch = createActiveMatch("online", { id: snapshot.matchId, boardSize });

        resetMatchTimers(snapshot.turn);
        startTimerDisplay();

        if (snapshot.status === "paused" && snapshot.disconnectedUser && snapshot.disconnectedUser !== client.userId) {
            handleOpponentDisconnected({
                gracePeriodMs: snapshot.gracePeriodMs || 15000,
                remainingGraceMs: snapshot.remainingGraceMs || 15000,
                expiresAt: snapshot.expiresAt
            });
        } else {
            stopDisconnectCountdown();
            isOpponentDisconnected = false;
            updateInterface();
            updateTimerDisplay();
        }
    });

    client.on("move_applied", data => {
        if (!isCurrentClient()) return;
        timerState.stopTurn(data.role);
        showMove(data.index, data.role);
        currentPlayer = data.nextTurn;
        if (currentPlayer === onlineMatch?.localSide) {
            timerState.startTurn(currentPlayer);
        }
        updateInterface();
        updateTimerDisplay();
    });

    client.on("invalid_move", data => {
        if (!isCurrentClient()) return;
        statusText.textContent = `Ход отклонён: ${data.reason}`;
        updateInterface();
    });

    client.on("opponent_disconnected", data => {
        if (!isCurrentClient()) return;
        handleOpponentDisconnected(data);
    });

    client.on("opponent_reconnected", () => {
        if (!isCurrentClient()) return;
        handleOpponentReconnected();
    });

    client.on("connection_lost", () => {
        if (!isCurrentClient() || gameOver) return;
        statusText.textContent = "Соединение потеряно. Переподключение к матчу…";
    });

    client.on("match_ended", data => {
        if (!isCurrentClient()) return;
        stopDisconnectCountdown();
        if (reconnectedMessageTimeout) {
            clearTimeout(reconnectedMessageTimeout);
            reconnectedMessageTimeout = null;
        }
        isOpponentDisconnected = false;

        timerState.finish();
        gameOver = true;
        stopTimerDisplay();

        if (Array.isArray(data.board)) {
            data.board.forEach((mark, idx) => {
                if (mark && board[idx] !== mark) {
                    showMove(idx, mark);
                }
            });
        }

        if (Array.isArray(data.winningLine)) {
            data.winningLine.forEach(idx => {
                if (cells[idx]) cells[idx].classList.add("winner");
            });
        }

        let message = "";
        let outcome = "loss";
        if (data.winner === "draw") {
            message = "Ничья!";
            outcome = "draw";
        } else if (data.winner === onlineMatch?.localSide) {
            if (data.reason === "abandoned" || data.reason === "disconnect_timeout") {
                message = "Время ожидания истекло. Вы победили! Соперник не вернулся.";
            } else if (data.reason === "timeout") {
                message = "Ты победил! (Соперник превысил время)";
            } else {
                message = "Ты победил!";
            }
            outcome = "win";
        } else {
            if (data.reason === "abandoned" || data.reason === "disconnect_timeout") {
                message = "Время ожидания истекло. Поражение: время на возвращение истекло.";
            } else if (data.reason === "timeout") {
                message = "Поражение: время на ход истекло";
            } else {
                message = "Победил соперник!";
            }
            outcome = "loss";
        }

        statusText.textContent = message;
        onlineResultMessage = message;
        if (onlineMatch) {
            onlineMatch.completed = true;
            onlineMatch.winner = data.winner;
        }

        const finalDuration = typeof data.durationMs === "number" ? data.durationMs : timerState.finish();
        const matchResult = createMatchResult(outcome, data.winner, finalDuration);
        if (matchResult) {
            window.dispatchEvent(new CustomEvent("tictactoe:match-completed", { detail: matchResult }));
        }

        updateInterface();
        updateTimerDisplay();
    });

    client.on("error", ({ message, error }) => {
        if (isCurrentClient()) handleOnlineError(message, error);
    });

    client.on("search_canceled", () => {
        if (isCurrentClient()) switchToComputer("Поиск отменён");
    });
}

async function startOnlineSearch() {
    const requestId = ++onlineStartRequestId;
    onlineStartPending = true;
    stopSearchTimer();
    stopDisconnectCountdown();
    if (reconnectedMessageTimeout) {
        clearTimeout(reconnectedMessageTimeout);
        reconnectedMessageTimeout = null;
    }
    isOpponentDisconnected = false;

    if (onlineServerClient) {
        onlineServerClient.dispose();
        onlineServerClient = null;
    }

    prepareOnlineSearch();
    gameMode = "online";
    onlineState = "searching";
    onlineStartPending = false;
    onlinePeerId = null;
    onlineErrorMessage = "";
    onlineMatch = null;
    onlineResultMessage = "";

    const client = new OnlineServerClient({ platformAdapter });
    onlineServerClient = client;
    const isCurrentClient = () => onlineServerClient === client && requestId === onlineStartRequestId;

    setupOnlineClientListeners(client, requestId);

    try {
        let profileName = client.devUser === "dev_user_2" ? "Игрок 2" : "Игрок 1";
        if (platformAdapter) {
            try {
                const info = await platformAdapter.getUserInfo();
                if (info?.first_name) {
                    profileName = info.last_name ? `${info.first_name} ${info.last_name}` : info.first_name;
                }
            } catch {}
        }
        const profile = { name: profileName };
        await client.startSearch(selectedBoardSize, profile);
    } catch (error) {
        if (isCurrentClient()) handleOnlineError(error.message);
    }

    updateInterface();
    updateTimerDisplay();
}

function switchToComputer(notice = "") {
    onlineStartRequestId += 1;
    onlineStartPending = false;
    stopSearchTimer();
    stopDisconnectCountdown();
    if (reconnectedMessageTimeout) {
        clearTimeout(reconnectedMessageTimeout);
        reconnectedMessageTimeout = null;
    }
    isOpponentDisconnected = false;

    if (onlineServerClient) {
        if (onlineState === "searching") {
            onlineServerClient.cancelSearch();
        } else {
            onlineServerClient.dispose();
        }
        onlineServerClient = null;
    }

    onlinePeerId = null;
    onlineErrorMessage = "";
    onlineState = "idle";
    gameMode = "computer";
    onlinePracticeClockStarted = false;
    cancelComputerMoveTimer();
    applySelectedBoardSizeToNewGame();
    applySelectedDifficultyToNewGame();
    currentPlayer = "X";
    gameOver = false;
    gameStarted = false;
    activeMatch = null;
    onlineMatch = null;
    onlineResultMessage = "";
    stopTimerDisplay();
    timerState.reset();
    renderBoard();
    updateTimerDisplay();
    updateInterface();

    if (notice) statusText.textContent = notice;
}

function handleModeButton(button) {
    if (button.dataset.mode === "computer") {
        if (gameMode === "online" || onlineStartPending) {
            const notice = onlineStartPending || ["searching", "connecting", "ready"].includes(onlineState)
                ? "Поиск отменён"
                : "";
            switchToComputer(notice);
        } else {
            updateModeButtons();
        }
        return;
    }

    if (gameMode === "online" && ["searching", "connecting", "ready"].includes(onlineState)) {
        switchToComputer("Поиск отменён");
        return;
    }

    startOnlineSearch();
}

function startGame() {
    if (gameStarted || gameOver) return;
    if (gameMode === "online" && onlineState !== "searching") return;
    gameStarted = true;
    applySelectedDifficultyToNewGame();
    activeMatch = gameMode === "computer" ? createActiveMatch() : null;
    if (gameMode === "online") startOnlinePracticeClock();
    else resetMatchTimers();
    updateInterface();
}

function restartGame() {
    if (gameMode === "online") {
        if (onlineState === "ready" && onlineMatch?.completed) {
            startOnlineSearch();
            return;
        }
        if (onlineState !== "searching") return;
        cancelComputerMoveTimer();
        applySelectedBoardSizeToNewGame();
        currentPlayer = "X";
        gameOver = false;
        gameStarted = true;
        applySelectedDifficultyToNewGame();
        activeMatch = null;
        renderBoard();
        startOnlinePracticeClock();
        updateInterface();
        updateTimerDisplay();
        return;
    }
    cancelComputerMoveTimer();

    applySelectedBoardSizeToNewGame();
    currentPlayer = "X";
    gameOver = false;
    gameStarted = true;
    applySelectedDifficultyToNewGame();
    activeMatch = gameMode === "computer" ? createActiveMatch() : null;
    renderBoard();
    resetMatchTimers();

    statusText.textContent = "Твой ход";
    updateInterface();
}

// Создаём сетку текущего размера и подключаем обработчик перезапуска.
renderBoard();
timerState.reset();
matchTimeValue.classList.add("result-neutral");
renderPreviousResult();
updateTimerDisplay();

restartButton.addEventListener("click", () => {
    if (gameMode === "online") {
        if (onlineState === "searching") {
            switchToComputer("Поиск отменён");
            return;
        }
        if (gameOver) {
            startOnlineSearch();
            return;
        }
        return;
    }

    if (!gameStarted && !gameOver) {
        startGame();
        return;
    }
    restartGame();
});

// Переключаем разделы интерфейса.
const navigationTabs = document.querySelectorAll(".nav-tab");
const tabPanels = document.querySelectorAll("[data-tab-panel]");

navigationTabs.forEach(tab => {
    tab.addEventListener("click", () => {
        const selectedPanel = tab.dataset.tab;

        navigationTabs.forEach(item => {
            const isSelected = item === tab;
            item.classList.toggle("is-active", isSelected);
            item.setAttribute("aria-selected", String(isSelected));
        });

        tabPanels.forEach(panel => {
            const isSelected = panel.id === selectedPanel;
            panel.classList.toggle("is-active", isSelected);
            panel.setAttribute("aria-hidden", String(!isSelected));
            panel.inert = !isSelected;
        });

        if (selectedPanel === "stats-view") {
            syncStatsFiltersFromGameSettings();
            renderStats();
            loadAndRenderLeaderboard(true);
        }
    });
});

// Настройки пока меняют только выбранное состояние интерфейса.
document.querySelectorAll("[data-choice-group]").forEach(button => {
    button.addEventListener("click", () => {
        const group = button.dataset.choiceGroup;

        if (group === "mode") {
            handleModeButton(button);
            return;
        }

        if (group === "difficulty") {
            selectedDifficulty = button.dataset.difficulty;
        }

        const boardSizeChanged = group === "size" &&
            selectedBoardSize !== Number(button.dataset.boardSize);
        if (group === "size") {
            selectedBoardSize = Number(button.dataset.boardSize);
        }

        document.querySelectorAll(`[data-choice-group="${group}"]`).forEach(option => {
            const isSelected = option === button;
            option.classList.toggle("is-selected", isSelected);
            option.setAttribute("aria-pressed", String(isSelected));
        });

        if (boardSizeChanged) {
            if (gameStarted || gameOver) {
                restartGame();
            } else {
                applySelectedBoardSizeToNewGame();
                renderBoard();
                updateTimerDisplay();
                updateInterface();
            }
        }
    });
});

function movePreventsFork(position, move) {
    if (move < 0 || position[move] !== "") return false;

    const afterComputerMove = position.slice();
    afterComputerMove[move] = "O";

    for (let opponentMove = 0; opponentMove < afterComputerMove.length; opponentMove++) {
        if (afterComputerMove[opponentMove] !== "") continue;

        afterComputerMove[opponentMove] = "X";
        const opponentAlreadyWon = getWinningCombination(afterComputerMove)?.some(
            index => afterComputerMove[index] === "X"
        );

        if (!opponentAlreadyWon) {
            let computerCanWinImmediately = false;

            for (let reply = 0; reply < afterComputerMove.length; reply++) {
                if (afterComputerMove[reply] !== "") continue;

                afterComputerMove[reply] = "O";
                const combination = getWinningCombination(afterComputerMove);
                if (combination && afterComputerMove[combination[0]] === "O") {
                    computerCanWinImmediately = true;
                }
                afterComputerMove[reply] = "";
                if (computerCanWinImmediately) break;
            }

            if (computerCanWinImmediately) {
                afterComputerMove[opponentMove] = "";
                continue;
            }

            let winningReplies = 0;

            for (let reply = 0; reply < afterComputerMove.length; reply++) {
                if (afterComputerMove[reply] !== "") continue;

                afterComputerMove[reply] = "X";
                const combination = getWinningCombination(afterComputerMove);
                if (combination && afterComputerMove[combination[0]] === "X") {
                    winningReplies++;
                }
                afterComputerMove[reply] = "";
            }

            if (winningReplies >= 2) return false;
        }

        afterComputerMove[opponentMove] = "";
    }

    return true;
}

function createDrawPosition(size) {
    let seed = size * 97 + 13;
    for (let attempt = 0; attempt < 1000; attempt++) {
        const position = Array.from({ length: size * size }, () => {
            seed = (seed * 48271) % 2147483647;
            return seed % 2 === 0 ? "X" : "O";
        });
        if (!getWinningCombination(position)) return position;
    }
    return [];
}

// Автоматические проверки ИИ.
function runAITests() {
    const forkPosition = ["X", "", "", "", "O", "", "", "", "X"];
    let mediumHardPickerCalls = 0;

    const tests = [
        {
            name: "ИИ выбирает немедленную победу",
            board: ["O", "O", "", "X", "X", "", "", "", ""],
            check: move => move === 2
        },
        {
            name: "ИИ блокирует победу X",
            board: ["X", "X", "", "O", "", "", "", "", ""],
            check: move => move === 2
        },
        {
            name: "ИИ выбирает только свободную клетку",
            board: ["X", "O", "X", "X", "O", "", "O", "X", ""],
            check: (move, position) =>
                move !== -1 && position[move] === ""
        },
        {
            name: "На заполненном поле ходов нет",
            board: ["X", "O", "X", "X", "O", "O", "O", "X", "X"],
            check: move => move === -1
        },
        {
            name: "Лёгкий может пропустить блокировку",
            board: ["X", "X", "", "O", "", "", "", "", ""],
            choose: position => chooseComputerMoveForDifficulty(position, "easy", {
                random: () => 0.99
            }),
            check: move => move === 8
        },
        {
            name: "Средний выбирает немедленную победу",
            board: ["O", "O", "", "X", "X", "", "", "", ""],
            choose: position => chooseComputerMoveForDifficulty(position, "medium"),
            check: move => move === 2
        },
        {
            name: "Средний блокирует немедленную победу X",
            board: ["X", "X", "", "O", "", "", "", "", ""],
            choose: position => chooseComputerMoveForDifficulty(position, "medium"),
            check: move => move === 2
        },
        {
            name: "Средний предотвращает вилку боковым ходом",
            board: forkPosition,
            choose: position => chooseComputerMoveForDifficulty(position, "medium", {
                random: () => 0
            }),
            check: (move, position) =>
                [1, 3, 5, 7].includes(move) && movePreventsFork(position, move)
        },
        {
            name: "Средний не вызывает сложный выбор minimax",
            board: ["O", "O", "", "X", "X", "", "", "", ""],
            choose: position => chooseComputerMoveForDifficulty(position, "medium", {
                hardMovePicker: () => {
                    mediumHardPickerCalls++;
                    return -1;
                }
            }),
            check: move => move === 2 && mediumHardPickerCalls === 0
        },
        {
            name: "Сложный minimax защищается от вилки",
            board: forkPosition,
            choose: position => chooseComputerMoveForDifficulty(position, "hard"),
            check: (move, position) =>
                [1, 3, 5, 7].includes(move) && movePreventsFork(position, move)
        }
    ];

    for (const size of [3, 4, 5]) {
        const openPosition = Array(size * size).fill("");
        openPosition[Math.floor(size * size / 2)] = "X";
        for (const difficulty of ["easy", "medium", "hard"]) {
            tests.push({
                name: `${size}×${size}: уровень ${difficulty} делает допустимый ход`,
                board: openPosition.slice(),
                choose: position => chooseComputerMoveForDifficulty(position, difficulty),
                check: (move, position) =>
                    move >= 0 && move < position.length && position[move] === ""
            });
        }

        const winningLines = [
            Array.from({ length: size }, (_, col) => col),
            Array.from({ length: size }, (_, row) => row * size),
            Array.from({ length: size }, (_, index) => index * size + index),
            Array.from({ length: size }, (_, index) => index * size + size - 1 - index)
        ];
        const directionNames = ["горизонталь", "вертикаль", "диагональ ↘", "диагональ ↙"];
        winningLines.forEach((line, index) => {
            const position = Array(size * size).fill("");
            line.forEach(cell => position[cell] = "X");
            tests.push({
                name: `${size}×${size}: победа по направлению ${directionNames[index]}`,
                board: position,
                choose: current => getWinningCombination(current),
                check: combination =>
                    Array.isArray(combination) && combination.length === size &&
                    line.every(cell => combination.includes(cell))
            });
        });

        tests.push({
            name: `${size}×${size}: заполненное поле без линии — ничья`,
            board: createDrawPosition(size),
            choose: position => isDrawPosition(position),
            check: isDraw => isDraw === true
        });

        for (const difficulty of ["medium", "hard"]) {
            const threat = Array(size * size).fill("");
            for (let col = 0; col < size - 1; col++) threat[col] = "X";
            threat[size * size - 1] = "O";
            tests.push({
                name: `${size}×${size}: уровень ${difficulty} блокирует угрозу X`,
                board: threat,
                choose: position => chooseComputerMoveForDifficulty(position, difficulty),
                check: move => move === size - 1
            });
        }
    }

    const results = tests.map(test => {
        const originalBoard = test.board.slice();
        const move = test.choose
            ? test.choose(test.board)
            : chooseComputerMoveForPosition(test.board);
        const moveLabel = move === -1
            ? "нет хода"
            : Array.isArray(move)
                ? `линия из ${move.length} клеток`
                : typeof move === "boolean"
                    ? (move ? "да" : "нет")
                    : move + 1;

        return {
            test: test.name,
            ход: moveLabel,
            результат:
                test.check(move, test.board) &&
                test.board.every((value, i) => value === originalBoard[i])
                    ? "ПРОЙДЕН"
                    : "ОШИБКА"
        };
    });

    const previousSelectedDifficulty = selectedDifficulty;
    const previousGameDifficulty = gameDifficulty;
    selectedDifficulty = "easy";
    gameDifficulty = "hard";
    const remainsCurrentLevelUntilRestart = gameDifficulty === "hard";
    const nextGameDifficulty = applySelectedDifficultyToNewGame();
    const difficultyAppliedToNextGame =
        remainsCurrentLevelUntilRestart && nextGameDifficulty === "easy";
    selectedDifficulty = previousSelectedDifficulty;
    gameDifficulty = previousGameDifficulty;

    results.push({
        test: "Новая сложность применяется со следующей партии",
        ход: "—",
        результат: difficultyAppliedToNextGame ? "ПРОЙДЕН" : "ОШИБКА"
    });

    const previousSelectedBoardSize = selectedBoardSize;
    const previousBoardSize = boardSize;
    const previousBoard = board;
    selectedBoardSize = 4;
    const appliedSize = applySelectedBoardSizeToNewGame();
    const sizeAppliedToNextGame = appliedSize === 4 && boardSize === 4 && board.length === 16;
    selectedBoardSize = previousSelectedBoardSize;
    boardSize = previousBoardSize;
    board = previousBoard;
    results.push({
        test: "Выбранный размер применяется к новой партии",
        ход: "—",
        результат: sizeAppliedToNextGame ? "ПРОЙДЕН" : "ОШИБКА"
    });

    console.table(results);

    const passed = results.filter(
        result => result.результат === "ПРОЙДЕН"
    ).length;

    console.log(`Результат: ${passed} из ${results.length} тестов пройдено`);

    return results;
}

// Оставляем тесты доступными для ручного запуска в DevTools.
window.runAITests = runAITests;

function runTimerTests() {
    let now = 1000;
    const results = [];
    const check = (name, actual, expected) => results.push({
        test: name,
        результат: Object.is(actual, expected) ? "ПРОЙДЕН" : "ОШИБКА",
        значение: actual
    });

    let waitingNow = 0;
    const waitingClock = createTimerState(() => waitingNow);
    waitingNow = 5000;
    check("В ожидании таймер партии не запущен", waitingClock.snapshot().matchMs, 0);
    check("В ожидании нет активного таймера хода", waitingClock.snapshot().activeTurn, null);
    waitingClock.startMatch("X");
    waitingNow = 5125;
    check("Запуск партии начинает отсчёт X с момента старта",
        waitingClock.snapshot().turnMs.X, 125);
    check("До запуска ожидание не добавилось к времени партии",
        waitingClock.snapshot().matchMs, 125);

    const clock = createTimerState(() => now);
    clock.startMatch("X");
    now = 2125;
    check("Таймер X запускается вместе с его очередью", clock.snapshot().turnMs.X, 1125);
    check("Таймер партии идёт во время хода X", clock.snapshot().matchMs, 1125);

    clock.stopTurn("O");
    now = 2500;
    check("Остановка чужого таймера не прерывает очередь X", clock.snapshot().activeTurn, "X");
    check("Таймер X останавливается на принятом ходе", clock.stopTurn("X"), 1500);

    clock.startTurn("O");
    now = 2850;
    check("Таймер O учитывает задержку до фактического хода", clock.snapshot().turnMs.O, 350);
    check("Таймер O останавливается после размещения", clock.stopTurn("O"), 350);

    clock.startTurn("X");
    now = 3000;
    check("Время X сбрасывается при новой очереди", clock.snapshot().turnMs.X, 150);
    check("Время партии не сбрасывается между ходами", clock.snapshot().matchMs, 2000);

    now = 3100;
    check("Завершение останавливает общий таймер", clock.finish(), 2100);
    const finishedSnapshot = clock.snapshot();
    now = 5000;
    check("Завершённый таймер партии остаётся зафиксирован", clock.snapshot().matchMs, 2100);
    check("После завершения нет активного таймера хода", finishedSnapshot.activeTurn, null);

    clock.reset();
    now = 6000;
    clock.startMatch("X");
    now = 6050;
    check("Новая партия начинает отсчёт заново", clock.snapshot().matchMs, 50);

    const computerFinishingClock = createTimerState(() => now);
    computerFinishingClock.startMatch("X");
    now += 100;
    computerFinishingClock.startTurn("O");
    now += 350;
    computerFinishingClock.finish();
    check("Завершение во время очереди O останавливает её таймер",
        computerFinishingClock.snapshot().activeTurn, null);

    check("Равные отображаемые сотые считаются равным результатом",
        compareMatchDurations(1231, 1234), "equal");
    check("Более быстрый результат определяется по сотым",
        compareMatchDurations(1200, 1300), "faster");
    check("Более медленный результат определяется по сотым",
        compareMatchDurations(1400, 1300), "slower");
    check("Для первой партии сравнение отсутствует",
        compareMatchDurations(1200, null), "uncompared");

    console.table(results);
    const passed = results.filter(result => result.результат === "ПРОЙДЕН").length;
    console.log(`Проверка таймеров: ${passed} из ${results.length} пройдено`);
    return results;
}

window.runTimerTests = runTimerTests;

function renderDevModeBadge() {
    if (typeof window === "undefined" || !document.body) return;

    // Не отображаем в боевой среде VK Mini Apps
    if (platformAdapter?.mode === "vk_mini_apps" || isVkMiniAppsMode()) {
        return;
    }

    const currentDevUser = platformAdapter?.getUserId() || (new URLSearchParams(window.location.search)).get("dev_user") || sessionStorage.getItem("tictactoe_dev_user") || "dev_user_1";
    const nextDevUser = currentDevUser === "dev_user_1" ? "dev_user_2" : "dev_user_1";

    let badge = document.querySelector("#dev-mode-badge");
    if (!badge) {
        badge = document.createElement("div");
        badge.id = "dev-mode-badge";
        badge.className = "dev-badge";
        const heading = document.querySelector(".tab-heading");
        if (heading && heading.parentNode) {
            heading.parentNode.insertBefore(badge, heading.nextSibling);
        }
    }

    badge.innerHTML = `
        <span>🔧 <strong>Dev-режим:</strong> <code>${currentDevUser}</code></span>
        <button type="button" id="switch-dev-user-btn" title="Переключить тестового игрока">Сменить на ${nextDevUser}</button>
    `;

    document.querySelector("#switch-dev-user-btn")?.addEventListener("click", () => {
        try {
            platformAdapter?.setDevUser(nextDevUser);
        } catch {}
        sessionStorage.setItem("tictactoe_dev_user", nextDevUser);
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set("dev_user", nextDevUser);
        window.location.href = newUrl.href;
    });
}

function initCommunityLink() {
    const communityBtn = document.querySelector(".about-channel-button");
    if (!communityBtn) return;

    if (platformAdapter?.mode === "vk_mini_apps") {
        communityBtn.textContent = "Сообщество PCP Games";
        communityBtn.removeAttribute("target");
        communityBtn.addEventListener("click", async event => {
            event.preventDefault();
            const groupId = window.TICTACTOE_ONLINE_CONFIG?.vkGroupId;
            if (groupId) {
                try {
                    await platformAdapter.joinGroup({ group_id: groupId });
                } catch (err) {
                    console.warn("PCP Games group join notice:", err);
                }
            } else {
                console.warn("PCP Games VK group ID is not configured yet (Block 2 requirement)");
            }
        });
    }
}

// Инициализация при загрузке: платформа, отображение Dev-бейджа и проверка Reconnect
(async function initClientEnvironment() {
    platformAdapter = createPlatformAdapter();
    try {
        await platformAdapter.init();
    } catch (err) {
        console.warn("Platform adapter init notice:", err?.message || err);
    }

    renderDevModeBadge();
    initCommunityLink();

    const client = new OnlineServerClient({ platformAdapter });
    const requestId = ++onlineStartRequestId;
    onlineServerClient = client;
    setupOnlineClientListeners(client, requestId);

    try {
        const restored = await client.checkAndRestoreSession();
        if (restored) {
            console.log("Восстановлена активная онлайн-сессия после перезагрузки страницы");
            gameMode = "online";
            onlineState = "connecting";
            updateModeButtons();
            updateInterface();
        } else {
            if (onlineServerClient === client) {
                onlineServerClient = null;
            }
            client.dispose();
        }
    } catch {
        if (onlineServerClient === client) {
            onlineServerClient = null;
        }
        client.dispose();
    }
})();

updateInterface();
