"use strict";

export const PLAYER_PROFILE_STORAGE_KEY = "tictactoe.player-profile.v1";
export const PLAYER_STATS_STORAGE_KEY = "tictactoe.player-stats.v1";
export const PLAYER_STATS_SCHEMA_VERSION = 1;

export function getPlayerStatsStorageKey(userId) {
    if (!userId) return PLAYER_STATS_STORAGE_KEY;
    const clean = String(userId).trim();
    if (!clean) return PLAYER_STATS_STORAGE_KEY;
    const prefix = clean.startsWith("vk_") ? clean : `vk_${clean}`;
    return `tictactoe.${prefix}.stats.v1`;
}

export function getPlayerProfileStorageKey(userId) {
    if (!userId) return PLAYER_PROFILE_STORAGE_KEY;
    const clean = String(userId).trim();
    if (!clean) return PLAYER_PROFILE_STORAGE_KEY;
    const prefix = clean.startsWith("vk_") ? clean : `vk_${clean}`;
    return `tictactoe.${prefix}.profile.v1`;
}

const DIFFICULTIES = ["easy", "medium", "hard"];
const BOARD_SIZES = [3, 4, 5];
let fallbackIdentityCounter = 0;

const volatileValues = new Map();
const volatileStorage = {
    getItem(key) {
        return volatileValues.has(key) ? volatileValues.get(key) : null;
    },
    setItem(key, value) {
        volatileValues.set(key, String(value));
    },
    removeItem(key) {
        volatileValues.delete(key);
    }
};

function resolveStorage(storage) {
    if (storage) return storage;

    try {
        if (globalThis.localStorage) return globalThis.localStorage;
    } catch {
        // Storage may be unavailable in private or restricted browser contexts.
    }

    return volatileStorage;
}

function randomToken() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        return Array.from(crypto.getRandomValues(new Uint32Array(4)), value =>
            value.toString(16).padStart(8, "0")
        ).join("");
    }

    fallbackIdentityCounter += 1;
    return `${Date.now().toString(36)}-${fallbackIdentityCounter}-${Math.random().toString(36).slice(2)}`;
}

function formatDisplayId(date) {
    const twoDigits = value => String(value).padStart(2, "0");
    return `ID_${twoDigits(date.getDate())}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}${twoDigits(date.getSeconds())}`;
}

function isValidProfile(value) {
    return value !== null &&
        typeof value === "object" &&
        value.schemaVersion === 1 &&
        typeof value.displayId === "string" &&
        value.displayId.length > 0 &&
        typeof value.identityKey === "string" &&
        value.identityKey.length > 0;
}

function preserveCorruptValue(storage, key, raw) {
    const suffix = `${Date.now()}-${randomToken()}`;
    try {
        storage.setItem(`${key}.backup.${suffix}`, raw);
        return true;
    } catch {
        return false;
    }
}

function createProfile(now, userId) {
    const date = now instanceof Date ? now : new Date(now);
    let displayId;
    if (userId) {
        const clean = String(userId).trim();
        displayId = clean.startsWith("vk_") ? clean : `vk_${clean}`;
    } else {
        displayId = formatDisplayId(date);
    }
    return Object.freeze({
        schemaVersion: 1,
        displayId,
        identityKey: randomToken()
    });
}

export function getOrCreatePlayerIdentity({ storage, userId, now = () => new Date() } = {}) {
    const targetStorage = resolveStorage(storage);
    const storageKey = getPlayerProfileStorageKey(userId);
    let raw = null;

    try {
        raw = targetStorage.getItem(storageKey);
    } catch {
        return createProfile(typeof now === "function" ? now() : now, userId);
    }

    if (raw !== null) {
        try {
            const existingProfile = JSON.parse(raw);
            if (isValidProfile(existingProfile)) {
                return Object.freeze({
                    schemaVersion: existingProfile.schemaVersion,
                    displayId: existingProfile.displayId,
                    identityKey: existingProfile.identityKey
                });
            }
        } catch {
            // Preserve malformed profile data below before replacing this key.
        }

        if (!preserveCorruptValue(targetStorage, storageKey, raw)) {
            return createProfile(typeof now === "function" ? now() : now, userId);
        }
    }

    const profile = createProfile(typeof now === "function" ? now() : now, userId);
    try {
        targetStorage.setItem(storageKey, JSON.stringify(profile));
    } catch {
        // Return a usable in-memory identity if persistent storage is blocked.
    }
    return profile;
}

export function getOrCreatePlayerId(options) {
    return getOrCreatePlayerIdentity(options).displayId;
}

export function getPlayerIdentityKey(options) {
    return getOrCreatePlayerIdentity(options).identityKey;
}

function isValidMatch(match) {
    if (!match || typeof match !== "object") return false;
    if (typeof match.id !== "string" || match.id.length === 0) return false;
    if (Number.isNaN(Date.parse(match.completedAt))) return false;
    if (!["win", "loss", "draw"].includes(match.result)) return false;
    if (!["computer", "online"].includes(match.mode)) return false;
    if (!BOARD_SIZES.includes(match.boardSize)) return false;
    if (!DIFFICULTIES.includes(match.difficulty)) return false;
    if (!Number.isFinite(match.durationMs) || match.durationMs < 0) return false;

    if (match.result === "draw") return match.winner === null;
    if (match.mode === "online") {
        return ["X", "O"].includes(match.winner) && ["win", "loss"].includes(match.result);
    }
    return (match.result === "win" && match.winner === "X") ||
        (match.result === "loss" && match.winner === "O");
}

function copyMatch(match) {
    return {
        id: match.id,
        completedAt: match.completedAt,
        result: match.result,
        winner: match.winner,
        mode: match.mode,
        boardSize: match.boardSize,
        difficulty: match.difficulty,
        durationMs: match.durationMs
    };
}

function emptyStore() {
    return { schemaVersion: PLAYER_STATS_SCHEMA_VERSION, matches: [] };
}

function loadStore(storage, userId) {
    const key = getPlayerStatsStorageKey(userId);
    let raw;
    try {
        raw = storage.getItem(key);
    } catch {
        return { store: emptyStore(), writable: false, key };
    }

    if (raw === null) return { store: emptyStore(), writable: true, key };

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const preserved = preserveCorruptValue(storage, key, raw);
        if (!preserved) return { store: emptyStore(), writable: false, key };
        try {
            storage.setItem(key, JSON.stringify(emptyStore()));
            return { store: emptyStore(), writable: true, key };
        } catch {
            return { store: emptyStore(), writable: false, key };
        }
    }

    if (parsed?.schemaVersion === PLAYER_STATS_SCHEMA_VERSION && Array.isArray(parsed.matches)) {
        const seenIds = new Set();
        const validMatches = parsed.matches.filter(match => {
            if (!isValidMatch(match) || seenIds.has(match.id)) return false;
            seenIds.add(match.id);
            return true;
        }).map(copyMatch);
        const hasInvalidEntries = validMatches.length !== parsed.matches.length;
        if (!hasInvalidEntries) return { store: { schemaVersion: PLAYER_STATS_SCHEMA_VERSION, matches: validMatches }, writable: true, key };

        if (!preserveCorruptValue(storage, key, raw)) {
            return { store: { schemaVersion: PLAYER_STATS_SCHEMA_VERSION, matches: validMatches }, writable: false, key };
        }
        const repaired = { schemaVersion: PLAYER_STATS_SCHEMA_VERSION, matches: validMatches };
        try {
            storage.setItem(key, JSON.stringify(repaired));
            return { store: repaired, writable: true, key };
        } catch {
            return { store: repaired, writable: false, key };
        }
    }

    if (!preserveCorruptValue(storage, key, raw)) {
        return { store: emptyStore(), writable: false, key };
    }
    try {
        storage.setItem(key, JSON.stringify(emptyStore()));
        return { store: emptyStore(), writable: true, key };
    } catch {
        return { store: emptyStore(), writable: false, key };
    }
}

export function getSavedMatches({ storage, userId } = {}) {
    const { store } = loadStore(resolveStorage(storage), userId);
    return store.matches.map(copyMatch);
}

export function addCompletedMatch(match, { storage, userId } = {}) {
    if (!isValidMatch(match)) return false;

    const targetStorage = resolveStorage(storage);
    const { store, writable, key } = loadStore(targetStorage, userId);
    if (!writable || store.matches.some(savedMatch => savedMatch.id === match.id)) return false;

    const updatedStore = {
        schemaVersion: PLAYER_STATS_SCHEMA_VERSION,
        matches: [...store.matches, copyMatch(match)]
    };

    try {
        targetStorage.setItem(key, JSON.stringify(updatedStore));
        return true;
    } catch {
        return false;
    }
}

function calculateCategoryStats(matches, difficulty, boardSize) {
    const categoryMatches = matches.filter(match =>
        match.difficulty === difficulty && match.boardSize === boardSize
    );
    const wins = categoryMatches.filter(match => match.result === "win").length;
    const losses = categoryMatches.filter(match => match.result === "loss").length;
    const draws = categoryMatches.filter(match => match.result === "draw").length;
    const winningTimes = categoryMatches
        .filter(match => match.mode === "computer" && match.result === "win" && match.winner === "X")
        .map(match => match.durationMs);

    return {
        difficulty,
        boardSize,
        gamesPlayed: categoryMatches.length,
        wins,
        losses,
        draws,
        bestWinMs: winningTimes.length > 0 ? Math.min(...winningTimes) : null
    };
}

function isValidCategory(difficulty, boardSize) {
    return DIFFICULTIES.includes(difficulty) && BOARD_SIZES.includes(boardSize);
}

export function getCategoryStats(difficulty, boardSize, { storage, userId } = {}) {
    if (!isValidCategory(difficulty, boardSize)) {
        throw new RangeError("Неизвестная категория статистики");
    }
    return calculateCategoryStats(getSavedMatches({ storage, userId }), difficulty, boardSize);
}

export function getOverallStats({ storage, userId } = {}) {
    const matches = getSavedMatches({ storage, userId });
    const categories = {};

    for (const difficulty of DIFFICULTIES) {
        for (const boardSize of BOARD_SIZES) {
            const key = `${difficulty}_${boardSize}x${boardSize}`;
            categories[key] = calculateCategoryStats(matches, difficulty, boardSize);
        }
    }

    const categoryStats = Object.values(categories);
    const winningTimes = categoryStats
        .map(item => item.bestWinMs)
        .filter(value => value !== null);
    return {
        gamesPlayed: categoryStats.reduce((total, item) => total + item.gamesPlayed, 0),
        wins: categoryStats.reduce((total, item) => total + item.wins, 0),
        losses: categoryStats.reduce((total, item) => total + item.losses, 0),
        draws: categoryStats.reduce((total, item) => total + item.draws, 0),
        bestWinMs: winningTimes.length > 0 ? Math.min(...winningTimes) : null,
        categories
    };
}
