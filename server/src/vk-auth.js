/**
 * Валидация параметров запуска VK Mini Apps.
 * Реализовано на нативном Web Crypto API (совместимо с Cloudflare Workers и Node.js 18+).
 */

/**
 * Преобразует бинарный буфер в строку Base64URL.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return base64
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * Проверяет подлинность параметров запуска VK Mini Apps по алгоритму HMAC-SHA256.
 *
 * @param {string | URLSearchParams | Record<string, string>} rawParams - Query-строка или объект параметров.
 * @param {string} clientSecret - Защищённый ключ приложения (Client Secret).
 * @param {{ maxAgeSeconds?: number, expectedAppId?: string }} [options={}] - Дополнительные проверки (срок актуальности, App ID).
 * @returns {Promise<{ isValid: boolean, userId: string | null, params: Record<string, string>, reason?: string }>}
 */
export async function verifyVkLaunchParams(rawParams, clientSecret, options = {}) {
    if (!clientSecret || typeof clientSecret !== "string") {
        return { isValid: false, userId: null, params: {}, reason: "Client secret is missing or invalid" };
    }

    let searchParams;
    if (typeof rawParams === "string") {
        const query = rawParams.startsWith("?") ? rawParams.slice(1) : rawParams;
        searchParams = new URLSearchParams(query);
    } else if (rawParams instanceof URLSearchParams) {
        searchParams = rawParams;
    } else if (rawParams && typeof rawParams === "object") {
        searchParams = new URLSearchParams(rawParams);
    } else {
        return { isValid: false, userId: null, params: {}, reason: "Invalid params format" };
    }

    const sign = searchParams.get("sign");
    if (!sign) {
        return { isValid: false, userId: null, params: {}, reason: "Sign parameter missing" };
    }

    // 1. Отбираем только параметры с префиксом vk_
    const vkEntries = [];
    const collectedParams = {};

    for (const [key, value] of searchParams.entries()) {
        if (key.startsWith("vk_")) {
            vkEntries.push([key, value]);
            collectedParams[key] = value;
        }
    }

    if (vkEntries.length === 0) {
        return { isValid: false, userId: null, params: {}, reason: "No vk_ parameters found" };
    }

    // 2. Сортируем параметры по алфавиту имен ключей
    vkEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    // 3. Формируем query-строку вида key1=value1&key2=value2
    const queryString = vkEntries
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");

    // 4. Вычисляем HMAC-SHA256 хэш
    const encoder = new TextEncoder();
    const keyData = encoder.encode(clientSecret);
    const messageData = encoder.encode(queryString);

    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, messageData);

    // 5. Кодируем в base64url
    const calculatedSign = bufferToBase64Url(signatureBuffer);

    // 6. Сверяем с переданным sign
    const isValid = calculatedSign === sign;
    const userId = collectedParams.vk_user_id || null;

    if (!isValid) {
        return { isValid: false, userId: null, params: collectedParams, reason: "Signature mismatch" };
    }

    // 7. Проверка App ID (если задано)
    if (options.expectedAppId && collectedParams.vk_app_id !== options.expectedAppId) {
        return { isValid: false, userId: null, params: collectedParams, reason: "App ID mismatch" };
    }

    // 8. Проверка срока актуальности (если передан vk_ts)
    if (collectedParams.vk_ts && options.maxAgeSeconds) {
        const nowSec = Math.floor(Date.now() / 1000);
        const paramTs = Number(collectedParams.vk_ts);
        if (Number.isFinite(paramTs) && nowSec - paramTs > options.maxAgeSeconds) {
            return { isValid: false, userId: null, params: collectedParams, reason: "Launch parameters expired" };
        }
    }

    return {
        isValid: true,
        userId,
        params: collectedParams
    };
}
