/**
 * Точка входа Cloudflare Worker для онлайн-мультиплеера TicTacToeA_VK.
 * Обрабатывает HTTP-маршруты (/api/auth, /api/leaderboard) и WebSocket (/ws).
 */

import { verifyVkLaunchParams } from "./vk-auth.js";
import { createGameToken, verifyGameToken } from "./token.js";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const ALLOWED_DEV_USERS = new Set(["dev_user_1", "dev_user_2"]);

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...CORS_HEADERS
        }
    });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);

        // 1. Авторизация и выпуск токена сессии
        if (url.pathname === "/api/auth" && request.method === "POST") {
            return handleAuth(request, env);
        }

        // 2. Получение топа глобального рейтинга
        if (url.pathname === "/api/leaderboard" && request.method === "GET") {
            return handleLeaderboard(request, env);
        }

        // 3. Подключение WebSocket (подготовка маршрута под Durable Objects)
        if (url.pathname === "/ws") {
            return handleWebSocket(request, env);
        }

        return jsonResponse({ error: "Not Found" }, 404);
    }
};

/**
 * Обработка авторизации (Development Mode + боевая проверка VK)
 */
async function handleAuth(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const secretKey = env?.VK_CLIENT_SECRET || env?.GAME_TOKEN_SECRET || "dev_secret_key_123";
    const isDevMode = env?.DEV_MODE === "true" || env?.DEV_MODE === true;

    // Ветвь А: Тестовая авторизация для локального Development Mode (DEC-010)
    if (body.devUser) {
        // Защита: Dev-авторизация строго запрещена, если DEV_MODE не включен
        if (!isDevMode) {
            return jsonResponse({ error: "Development authorization is disabled in production" }, 403);
        }

        // Защита: разрешены только зарегистрированные тестовые аккаунты dev_user_1 и dev_user_2
        if (!ALLOWED_DEV_USERS.has(body.devUser)) {
            return jsonResponse({ error: "Unknown development user. Allowed: dev_user_1, dev_user_2" }, 400);
        }

        const userId = body.devUser;
        const token = await createGameToken(
            { userId, appId: "dev_app" },
            secretKey,
            3600 // 1 час для локальной отладки
        );

        return jsonResponse({
            token,
            userId,
            dev: true,
            expiresIn: 3600
        });
    }

    // Ветвь Б: Проверка параметров запуска VK Mini Apps
    if (!body.launchParams) {
        return jsonResponse({ error: "Missing launchParams or devUser" }, 400);
    }

    if (!env?.VK_CLIENT_SECRET) {
        return jsonResponse({ error: "Server misconfiguration" }, 500);
    }

    const maxAgeSeconds = env?.PARAM_MAX_AGE_SECONDS ? Number(env.PARAM_MAX_AGE_SECONDS) : 86400; // 24 часа по умолчанию
    const verifyResult = await verifyVkLaunchParams(body.launchParams, env.VK_CLIENT_SECRET, {
        expectedAppId: env?.VK_APP_ID || undefined,
        maxAgeSeconds
    });

    if (!verifyResult.isValid) {
        if (verifyResult.reason === "App ID mismatch") {
            return jsonResponse({ error: "App ID mismatch" }, 403);
        }
        if (verifyResult.reason === "Launch parameters expired") {
            return jsonResponse({ error: "Launch parameters expired" }, 401);
        }
        return jsonResponse({ error: "Invalid VK signature" }, 401);
    }

    const userId = verifyResult.userId;
    const appId = verifyResult.params.vk_app_id || "";

    // Опциональное кэширование профиля в D1 (если подключена база)
    if (env.DB && userId) {
        try {
            const now = Date.now();
            await env.DB.prepare(`
                INSERT INTO users (vk_user_id, first_name, last_name, avatar_url, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(vk_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
            `).bind(
                userId,
                body.profile?.firstName || `Игрок ${userId.slice(-4)}`,
                body.profile?.lastName || "",
                body.profile?.avatarUrl || null,
                now,
                now
            ).run();
        } catch (dbErr) {
            console.error("D1 profile upsert warning:", dbErr);
        }
    }

    const token = await createGameToken(
        { userId, appId },
        secretKey,
        600 // 10 минут
    );

    return jsonResponse({
        token,
        userId,
        expiresIn: 600
    });
}

/**
 * Чтение лидерборда из Cloudflare D1
 */
async function handleLeaderboard(request, env) {
    if (!env?.DB) {
        return jsonResponse({ leaderboard: [] });
    }

    try {
        const { results } = await env.DB.prepare(`
            SELECT 
                l.vk_user_id,
                u.first_name,
                u.last_name,
                u.avatar_url,
                l.rating,
                l.games_played,
                l.wins,
                l.best_win_time_ms
            FROM leaderboards l
            LEFT JOIN users u ON l.vk_user_id = u.vk_user_id
            ORDER BY l.rating DESC
            LIMIT 10
        `).all();

        return jsonResponse({ leaderboard: results || [] });
    } catch (err) {
        console.error("D1 leaderboard query error:", err);
        return jsonResponse({ leaderboard: [] });
    }
}

/**
 * Проверка токена и маршрутизация WebSocket в Durable Object
 */
async function handleWebSocket(request, env) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const secretKey = env?.VK_CLIENT_SECRET || env?.GAME_TOKEN_SECRET || "dev_secret_key_123";

    const tokenVerify = await verifyGameToken(token, secretKey);
    if (!tokenVerify.isValid) {
        return jsonResponse({ error: "Unauthorized WebSocket connection" }, 401);
    }

    // Маршрутизация в Matchmaker Durable Object
    if (!env?.MATCHMAKER) {
        return jsonResponse({ error: "MATCHMAKER binding missing" }, 500);
    }

    const matchmakerId = env.MATCHMAKER.idFromName("global-queue");
    const matchmaker = env.MATCHMAKER.get(matchmakerId);

    const modifiedRequest = new Request(request, {
        headers: {
            ...Object.fromEntries(request.headers.entries()),
            "X-User-Id": tokenVerify.userId,
            "X-App-Id": tokenVerify.appId || ""
        }
    });

    return matchmaker.fetch(modifiedRequest);
}

// Заглушка Durable Object для Matchmaker
export class Matchmaker {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }

    async fetch(request) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const userId = request.headers.get("X-User-Id") || "unknown";

        server.accept();
        server.send(JSON.stringify({ type: "auth_ok", userId }));

        return new Response(null, {
            status: 101,
            webSocket: client
        });
    }
}

// Заглушка Durable Object для Match (комнаты партии)
export class Match {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }

    async fetch(request) {
        return new Response("Match room stub", { status: 200 });
    }
}
