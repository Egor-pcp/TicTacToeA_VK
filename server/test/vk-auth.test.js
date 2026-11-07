import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyVkLaunchParams } from "../src/vk-auth.js";

// Вспомогательная функция для генерации валидной подписи в тесте
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

test("Успешная валидация корректной подписи параметров запуска VK", async () => {
    const secret = "test_secret_key_12345";
    const baseParams = {
        vk_app_id: "51234567",
        vk_user_id: "987654321",
        vk_platform: "mobile_web",
        vk_language: "ru",
        extra_ignored_param: "should_not_affect_sign"
    };

    const sign = await generateTestSign(baseParams, secret);
    const queryString = `?${new URLSearchParams({ ...baseParams, sign }).toString()}`;

    const result = await verifyVkLaunchParams(queryString, secret);

    assert.equal(result.isValid, true);
    assert.equal(result.userId, "987654321");
    assert.equal(result.params.vk_app_id, "51234567");
    assert.equal(result.params.vk_platform, "mobile_web");
    assert.equal(result.params.extra_ignored_param, undefined); // Не-vk_ параметры отфильтрованы
});

test("Отказ при подмене vk_user_id злоумышленником", async () => {
    const secret = "test_secret_key_12345";
    const baseParams = {
        vk_app_id: "51234567",
        vk_user_id: "987654321",
        vk_platform: "mobile_web"
    };

    const sign = await generateTestSign(baseParams, secret);

    // Злоумышленник пытается подменить user_id на чужой
    const tamperedParams = {
        ...baseParams,
        vk_user_id: "111111111",
        sign
    };

    const result = await verifyVkLaunchParams(new URLSearchParams(tamperedParams), secret);

    assert.equal(result.isValid, false);
    assert.equal(result.userId, null);
    assert.equal(result.reason, "Signature mismatch");
});

test("Отказ при отсутствии параметра sign", async () => {
    const secret = "test_secret_key_12345";
    const queryString = "?vk_app_id=51234567&vk_user_id=987654321";

    const result = await verifyVkLaunchParams(queryString, secret);

    assert.equal(result.isValid, false);
    assert.equal(result.reason, "Sign parameter missing");
});

test("Отказ при отсутствии или некорректном clientSecret", async () => {
    const queryString = "?vk_user_id=123&sign=dummy";

    const result = await verifyVkLaunchParams(queryString, "");

    assert.equal(result.isValid, false);
    assert.equal(result.reason, "Client secret is missing or invalid");
});
