import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { verifyGameToken } from "../src/token.js";

// Генерация валидной подписи VK в тестах
async function generateTestSign(params, secret) {
    const vkEntries = Object.entries(params)
        .filter(([k]) => k.startsWith("vk_"))
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const queryString = vkEntries
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");

    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(queryString));
    const bytes = new Uint8Array(signatureBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

test("OPTIONS запрос возвращает CORS заголовки", async () => {
    const request = new Request("https://example.com/api/auth", { method: "OPTIONS" });
    const response = await worker.fetch(request, {});
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("POST /api/auth: Успешная Dev-авторизация (dev_user_1)", async () => {
    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devUser: "dev_user_1" })
    });
    const env = { DEV_MODE: "true", VK_CLIENT_SECRET: "test_secret" };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(data.userId, "dev_user_1");
    assert.equal(data.dev, true);
    assert.equal(typeof data.token, "string");

    // Проверяем валидность выданного токена
    const tokenVerify = await verifyGameToken(data.token, env.VK_CLIENT_SECRET);
    assert.equal(tokenVerify.isValid, true);
    assert.equal(tokenVerify.userId, "dev_user_1");
});

test("POST /api/auth: Отказ неизвестному тестовому пользователю", async () => {
    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devUser: "unknown_hacker" })
    });
    const env = { DEV_MODE: "true", VK_CLIENT_SECRET: "test_secret" };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 400);

    const data = await response.json();
    assert.equal(data.error.includes("Unknown development user"), true);
});

test("POST /api/auth: Отказ Dev-авторизации в production режиме (DEV_MODE не true)", async () => {
    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devUser: "dev_user_1" })
    });
    const env = { DEV_MODE: "false", VK_CLIENT_SECRET: "prod_secret" };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 403);
});

test("POST /api/auth: Успешная авторизация с боевыми параметрами запуска VK", async () => {
    const secret = "test_secret_key_999";
    const nowSec = Math.floor(Date.now() / 1000);
    const vkParams = {
        vk_app_id: "51234567",
        vk_user_id: "12345678",
        vk_platform: "mobile_web",
        vk_ts: String(nowSec)
    };
    const sign = await generateTestSign(vkParams, secret);
    const launchParams = `?${new URLSearchParams({ ...vkParams, sign }).toString()}`;

    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launchParams })
    });
    const env = { VK_CLIENT_SECRET: secret, VK_APP_ID: "51234567" };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(data.userId, "12345678");
    assert.equal(typeof data.token, "string");

    // Проверяем валидность выданного игрового токена
    const tokenVerify = await verifyGameToken(data.token, secret);
    assert.equal(tokenVerify.isValid, true);
    assert.equal(tokenVerify.userId, "12345678");
});

test("POST /api/auth: Отказ при искаженной подписи", async () => {
    const secret = "test_secret_key_999";
    const launchParams = "?vk_app_id=51234567&vk_user_id=12345678&sign=invalid_sign";

    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launchParams })
    });
    const env = { VK_CLIENT_SECRET: secret };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
});

test("POST /api/auth: Отказ при просроченных параметрах запуска (vk_ts)", async () => {
    const secret = "test_secret_key_999";
    const oldTimestamp = Math.floor(Date.now() / 1000) - 100000; // Просрочено более чем на 24 часа
    const vkParams = {
        vk_app_id: "51234567",
        vk_user_id: "12345678",
        vk_ts: String(oldTimestamp)
    };
    const sign = await generateTestSign(vkParams, secret);
    const launchParams = `?${new URLSearchParams({ ...vkParams, sign }).toString()}`;

    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launchParams })
    });
    const env = { VK_CLIENT_SECRET: secret, PARAM_MAX_AGE_SECONDS: "86400" };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);

    const data = await response.json();
    assert.equal(data.error, "Launch parameters expired");
});

test("POST /api/auth: Отказ при несовпадении VK_APP_ID", async () => {
    const secret = "test_secret_key_999";
    const vkParams = {
        vk_app_id: "99999999", // Чужой App ID
        vk_user_id: "12345678"
    };
    const sign = await generateTestSign(vkParams, secret);
    const launchParams = `?${new URLSearchParams({ ...vkParams, sign }).toString()}`;

    const request = new Request("https://example.com/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launchParams })
    });
    const env = { VK_CLIENT_SECRET: secret, VK_APP_ID: "51234567" }; // Ожидаемый App ID

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 403);
});

test("GET /api/leaderboard: Возвращает список лидеров", async () => {
    const request = new Request("https://example.com/api/leaderboard", { method: "GET" });
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(Array.isArray(data.leaderboard), true);
});

test("GET /ws: Отказ без валидного токена", async () => {
    const request = new Request("https://example.com/ws", {
        method: "GET",
        headers: { Upgrade: "websocket" }
    });
    const env = { VK_CLIENT_SECRET: "test_secret" };

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 401);
});
