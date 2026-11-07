import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameToken, verifyGameToken } from "../src/token.js";

test("Успешное создание и валидация игрового токена", async () => {
    const secret = "app_secret_abc123";
    const token = await createGameToken({ userId: "998877", appId: "51234567" }, secret, 600);

    assert.equal(typeof token, "string");
    assert.equal(token.includes("."), true);

    const result = await verifyGameToken(token, secret);
    assert.equal(result.isValid, true);
    assert.equal(result.userId, "998877");
    assert.equal(result.appId, "51234567");
});

test("Отказ при проверке просроченного токена", async () => {
    const secret = "app_secret_abc123";
    // Создаем токен с отрицательным сроком жизни (-10 сек)
    const token = await createGameToken({ userId: "998877" }, secret, -10);

    const result = await verifyGameToken(token, secret);
    assert.equal(result.isValid, false);
    assert.equal(result.reason, "Token expired");
});

test("Отказ при несовпадении секретного ключа", async () => {
    const secretA = "key_aaa";
    const secretB = "key_bbb";
    const token = await createGameToken({ userId: "998877" }, secretA, 600);

    const result = await verifyGameToken(token, secretB);
    assert.equal(result.isValid, false);
    assert.equal(result.reason, "Signature mismatch");
});

test("Отказ при искажении подписи или payload", async () => {
    const secret = "app_secret_abc123";
    const token = await createGameToken({ userId: "998877" }, secret, 600);
    const tamperedToken = `${token}tampered`;

    const result = await verifyGameToken(tamperedToken, secret);
    assert.equal(result.isValid, false);
});
