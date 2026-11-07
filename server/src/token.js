/**
 * Генерация и проверка короткоживущих игровых токенов сессии.
 * Реализовано на нативном Web Crypto API (HMAC-SHA256, без сторонних зависимостей).
 */

function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function base64UrlToBuffer(base64Url) {
    let base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) {
        base64 += "=";
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Выпускает подписанный токен сессии для подключения к WebSocket.
 *
 * @param {{ userId: string, appId: string }} payload - Данные пользователя.
 * @param {string} secretKey - Секретный ключ приложения.
 * @param {number} expiresInSeconds - Срок действия в секундах (по умолчанию 10 минут = 600 сек).
 * @returns {Promise<string>} Строка формата "<payload_base64url>.<signature_base64url>"
 */
export async function createGameToken(payload, secretKey, expiresInSeconds = 600) {
    if (!secretKey || typeof secretKey !== "string") {
        throw new TypeError("secretKey is required for token creation");
    }
    if (!payload?.userId) {
        throw new TypeError("payload.userId is required");
    }

    const now = Math.floor(Date.now() / 1000);
    const tokenData = {
        sub: String(payload.userId),
        app: String(payload.appId || ""),
        iat: now,
        exp: now + expiresInSeconds
    };

    const encoder = new TextEncoder();
    const payloadJson = JSON.stringify(tokenData);
    const payloadBase64 = bufferToBase64Url(encoder.encode(payloadJson));

    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secretKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        encoder.encode(payloadBase64)
    );

    const signatureBase64 = bufferToBase64Url(signatureBuffer);
    return `${payloadBase64}.${signatureBase64}`;
}

/**
 * Проверяет подпись и срок действия токена сессии.
 *
 * @param {string} token - Токен формата "<payload>.<signature>".
 * @param {string} secretKey - Секретный ключ приложения.
 * @returns {Promise<{ isValid: boolean, userId: string | null, appId: string | null, reason?: string }>}
 */
export async function verifyGameToken(token, secretKey) {
    if (!token || typeof token !== "string") {
        return { isValid: false, userId: null, appId: null, reason: "Missing token" };
    }
    if (!secretKey || typeof secretKey !== "string") {
        return { isValid: false, userId: null, appId: null, reason: "Missing secret key" };
    }

    const parts = token.split(".");
    if (parts.length !== 2) {
        return { isValid: false, userId: null, appId: null, reason: "Malformed token" };
    }

    const [payloadBase64, signatureBase64] = parts;
    const encoder = new TextEncoder();

    // 1. Проверяем HMAC-SHA256 подпись
    try {
        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            encoder.encode(secretKey),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["verify"]
        );

        const expectedSignature = base64UrlToBuffer(signatureBase64);
        const isSignatureValid = await crypto.subtle.verify(
            "HMAC",
            cryptoKey,
            expectedSignature,
            encoder.encode(payloadBase64)
        );

        if (!isSignatureValid) {
            return { isValid: false, userId: null, appId: null, reason: "Signature mismatch" };
        }
    } catch {
        return { isValid: false, userId: null, appId: null, reason: "Signature verification failed" };
    }

    // 2. Декодируем и проверяем payload
    let tokenData;
    try {
        const payloadBytes = base64UrlToBuffer(payloadBase64);
        const payloadString = new TextDecoder().decode(payloadBytes);
        tokenData = JSON.parse(payloadString);
    } catch {
        return { isValid: false, userId: null, appId: null, reason: "Invalid payload JSON" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (!tokenData.exp || tokenData.exp < now) {
        return { isValid: false, userId: null, appId: null, reason: "Token expired" };
    }

    return {
        isValid: true,
        userId: tokenData.sub,
        appId: tokenData.app || null
    };
}
