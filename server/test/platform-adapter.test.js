import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
    PlatformAdapter,
    MockPlatformAdapter,
    VkBridgeAdapter,
    createPlatformAdapter,
    isVkMiniAppsMode,
    isDevelopmentEnvironment,
    AdCooldownManager
} from "../../platform-adapter.js";
import { OnlineServerClient } from "../../OnlineServerClient.js";
import {
    getPlayerStatsStorageKey,
    getPlayerProfileStorageKey,
    addCompletedMatch,
    getSavedMatches
} from "../../player-stats.js";
import worker from "../src/worker.js";

function createMockBridge(customHandlers = {}) {
    const calls = [];
    return {
        calls,
        async send(method, params = {}) {
            calls.push({ method, params });
            if (customHandlers[method]) {
                return customHandlers[method](params);
            }
            if (method === "VKWebAppInit") return { result: true };
            if (method === "VKWebAppGetUserInfo") return { id: 123456, first_name: "Иван", last_name: "Тестов", photo_200: "https://vk.com/photo.jpg" };
            if (method === "VKWebAppShowNativeAds") return { result: true };
            if (method === "VKWebAppJoinGroup") return { result: true };
            return { result: true };
        }
    };
}

describe("VK-003-007: Платформенная интеграция (MockPlatformAdapter / VkBridgeAdapter)", () => {
    test("1. Выбор MockPlatformAdapter в Development Mode", () => {
        const adapter = createPlatformAdapter({ searchUrl: "?dev_user=dev_user_1" });
        assert.equal(adapter instanceof MockPlatformAdapter, true);
        assert.equal(adapter.isMock, true);
        assert.equal(adapter.mode, "development");
        assert.equal(adapter.getUserId(), "dev_user_1");
        assert.equal(adapter.getLaunchParams(), null);
    });

    test("2. Выбор VkBridgeAdapter в VK Mini Apps Mode при наличии параметров запуска", () => {
        const vkSearch = "?vk_user_id=777&vk_app_id=512345&vk_ts=1700000000&sign=abcdef";
        assert.equal(isVkMiniAppsMode(vkSearch), true);

        const adapter = createPlatformAdapter({ searchUrl: vkSearch });
        assert.equal(adapter instanceof VkBridgeAdapter, true);
        assert.equal(adapter.isMock, false);
        assert.equal(adapter.mode, "vk_mini_apps");
        assert.equal(adapter.getUserId(), "777");
        assert.equal(adapter.getLaunchParams(), vkSearch.slice(1));
    });

    test("3. Раздельное получение идентификаторов dev_user_1 и dev_user_2", async () => {
        const adapter1 = new MockPlatformAdapter({ devUser: "dev_user_1" });
        const adapter2 = new MockPlatformAdapter({ devUser: "dev_user_2" });

        assert.equal(adapter1.getUserId(), "dev_user_1");
        assert.equal(adapter2.getUserId(), "dev_user_2");

        const info1 = await adapter1.getUserInfo();
        const info2 = await adapter2.getUserInfo();

        assert.equal(info1.first_name, "Игрок 1");
        assert.equal(info2.first_name, "Игрок 2");
        assert.equal(info1.is_mock, true);

        // Переключение пользователя
        adapter1.setDevUser("dev_user_2");
        assert.equal(adapter1.getUserId(), "dev_user_2");

        // Отказ при недопустимом пользователе
        assert.throws(() => adapter1.setDevUser("hacker_user"), /Unsupported dev user/);
    });

    test("4. Сохранение изоляции статистики пользователей через адаптер", () => {
        const store = new Map();
        const mockStorage = {
            getItem(key) { return store.has(key) ? store.get(key) : null; },
            setItem(key, val) { store.set(key, String(val)); },
            removeItem(key) { store.delete(key); }
        };

        const adapter1 = new MockPlatformAdapter({ devUser: "dev_user_1" });
        const adapter2 = new MockPlatformAdapter({ devUser: "dev_user_2" });

        const key1 = getPlayerStatsStorageKey(adapter1.getUserId());
        const key2 = getPlayerStatsStorageKey(adapter2.getUserId());

        assert.equal(key1, "tictactoe.vk_dev_user_1.stats.v1");
        assert.equal(key2, "tictactoe.vk_dev_user_2.stats.v1");
        assert.notEqual(key1, key2);

        addCompletedMatch({
            id: "match-p1",
            completedAt: new Date().toISOString(),
            result: "win",
            winner: "X",
            mode: "online",
            boardSize: 3,
            difficulty: "medium",
            durationMs: 10000
        }, { storage: mockStorage, userId: adapter1.getUserId() });

        const user1Matches = getSavedMatches({ storage: mockStorage, userId: adapter1.getUserId() });
        const user2Matches = getSavedMatches({ storage: mockStorage, userId: adapter2.getUserId() });

        assert.equal(user1Matches.length, 1);
        assert.equal(user2Matches.length, 0);
    });

    test("5. Невозможность использования моковой авторизации в боевом режиме (серверный барьер)", async () => {
        // Сервер без DEV_MODE=true отклоняет devUser
        const prodEnv = { DEV_MODE: "false", VK_CLIENT_SECRET: "secret" };
        const req = new Request("https://example.com/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ devUser: "dev_user_1" })
        });

        const res = await worker.fetch(req, prodEnv);
        assert.equal(res.status, 403);
        const data = await res.json();
        assert.match(data.error, /disabled in production/);
    });

    test("6. Невозможность подмены реального VK ID в боевом режиме", async () => {
        // Злоумышленник пытается отправить launchParams с поддельным vk_user_id
        const fakeLaunchParams = "vk_user_id=999999&vk_app_id=123&vk_ts=1700000000&sign=fake_signature";
        const prodEnv = { DEV_MODE: "false", VK_CLIENT_SECRET: "real_secret" };
        const req = new Request("https://example.com/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ launchParams: fakeLaunchParams })
        });

        const res = await worker.fetch(req, prodEnv);
        assert.equal(res.status, 401); // Отклонено сервером из-за несовпадения HMAC
    });

    test("7. VkBridgeAdapter выбрасывает исключение при вызове setDevUser", () => {
        const adapter = new VkBridgeAdapter({ launchParams: "vk_user_id=100&vk_app_id=200" });
        assert.throws(() => adapter.setDevUser("dev_user_1"), /Cannot set dev user in VK Mini Apps Mode/);
    });

    test("8. Обработка отсутствующего VK Bridge в VkBridgeAdapter (без тихого перехода на мок)", async () => {
        const adapter = new VkBridgeAdapter({ bridge: null, launchParams: "vk_user_id=100&vk_app_id=200" });
        assert.equal(adapter.isBridgeAvailable(), false);

        await assert.rejects(async () => {
            await adapter.init();
        }, /VK Bridge is not available/);

        await assert.rejects(async () => {
            await adapter.showNativeAds();
        }, /VK Bridge is not available/);

        await assert.rejects(async () => {
            await adapter.joinGroup({ group_id: 123 });
        }, /VK Bridge is not available/);
    });

    test("9. Обработка ошибок и успешные вызовы платформенных методов VkBridgeAdapter", async () => {
        const mockBridge = createMockBridge({
            VKWebAppShowNativeAds: async () => { throw new Error("Ad not ready"); },
            VKWebAppJoinGroup: async ({ group_id }) => ({ result: true, group_id })
        });

        const adapter = new VkBridgeAdapter({
            bridge: mockBridge,
            launchParams: "vk_user_id=500&vk_app_id=600"
        });

        assert.equal(adapter.isBridgeAvailable(), true);

        // Инициализация
        const initResult = await adapter.init();
        assert.deepEqual(initResult, { result: true });
        assert.equal(mockBridge.calls[0].method, "VKWebAppInit");

        // Ошибка показа рекламы пробрасывается
        await assert.rejects(async () => {
            await adapter.showNativeAds({ ad_format: "interstitial" });
        }, /Ad not ready/);

        // Ошибка при отсутствии group_id
        await assert.rejects(async () => {
            await adapter.joinGroup({});
        }, /PCP Games VK group ID is not configured/);

        // Успешное вступление в группу
        const joinResult = await adapter.joinGroup({ group_id: 999 });
        assert.deepEqual(joinResult, { result: true, group_id: 999 });
    });

    test("10. Интеграция с OnlineServerClient: корректная передача launchParams или devUser", async () => {
        // Dev Mode адаптер
        const mockAdapter = new MockPlatformAdapter({ devUser: "dev_user_2" });
        const clientDev = new OnlineServerClient({ platformAdapter: mockAdapter });
        assert.equal(clientDev.devUser, "dev_user_2");
        assert.equal(clientDev.launchParams, null);

        // VK Mode адаптер
        const vkLaunch = "vk_user_id=888&vk_app_id=999&sign=test";
        const vkAdapter = new VkBridgeAdapter({ launchParams: vkLaunch });
        const clientVk = new OnlineServerClient({ platformAdapter: vkAdapter });
        assert.equal(clientVk.launchParams, vkLaunch);
        // При наличии launchParams клиент не использует devUser для отправки
    });

    test("11. Мок-реклама и вступление в сообщество в MockPlatformAdapter", async () => {
        const mockAdapter = new MockPlatformAdapter({ devUser: "dev_user_1" });

        const adRes = await mockAdapter.showNativeAds({ ad_format: "interstitial" });
        assert.equal(adRes.result, true);
        assert.equal(adRes.mock, true);
        assert.equal(mockAdapter.adsCallCount, 1);
        assert.equal(mockAdapter.lastAdFormat, "interstitial");

        const groupRes = await mockAdapter.joinGroup({ group_id: 7777 });
        assert.equal(groupRes.result, true);
        assert.equal(groupRes.mock, true);
        assert.equal(mockAdapter.groupJoinCalls.length, 1);
        assert.equal(mockAdapter.groupJoinCalls[0].group_id, 7777);
    });

    test("12. Имитация сбоев мок-методов в MockPlatformAdapter для тестирования отказоустойчивости", async () => {
        const failingAdapter = new MockPlatformAdapter({
            adMockResult: false,
            groupMockResult: false
        });

        await assert.rejects(async () => {
            await failingAdapter.showNativeAds();
        }, /Mock ad display failed/);

        await assert.rejects(async () => {
            await failingAdapter.joinGroup({ group_id: 123 });
        }, /Mock group join failed/);
    });

    test("13. Защита продакшена: createPlatformAdapter без VK-параметров не возвращает MockPlatformAdapter", async () => {
        const prodAdapter = createPlatformAdapter({ isProduction: true, searchUrl: "" });
        assert.equal(prodAdapter instanceof VkBridgeAdapter, true);
        assert.equal(prodAdapter.isMock, false);
        assert.equal(prodAdapter.mode, "vk_mini_apps");
        assert.equal(prodAdapter.getLaunchParams(), null);

        // Попытка инициализации без моста в продакшене выбрасывает ошибку, а не тихо даёт доступ
        await assert.rejects(async () => {
            await prodAdapter.init();
        }, /VK Bridge is not available/);
    });

    test("14. isVkMiniAppsMode валидирует параметры запуска и наличие bridge", () => {
        // Полные параметры
        assert.equal(isVkMiniAppsMode("?vk_user_id=123&vk_app_id=456&sign=abc"), true);
        // Только user_id и sign
        assert.equal(isVkMiniAppsMode("?vk_user_id=123&sign=abc"), true);
        // Недостаточные параметры (только vk_user_id без app/sign)
        assert.equal(isVkMiniAppsMode("?vk_user_id=123"), false);
        // Параметры разработки
        assert.equal(isVkMiniAppsMode("?dev_user=dev_user_1"), false);
        // Пустая строка
        assert.equal(isVkMiniAppsMode(""), false);
        // Наличие bridge
        assert.equal(isVkMiniAppsMode("", { send: async () => ({}) }), true);
    });

    test("15. AdCooldownManager: успешный показ рекламы обновляет lastAdShownAt и блокирует повторный вызов в пределах 60с", async () => {
        const mockAdapter = new MockPlatformAdapter({ devUser: "dev_user_1" });
        const manager = new AdCooldownManager({ platformAdapter: mockAdapter, cooldownMs: 60000 });

        assert.equal(manager.getLastAdShownAt(), 0);

        // Первый вызов — успешен
        const firstResult = await manager.maybeShowInterstitialAd();
        assert.equal(firstResult, true);
        assert.equal(mockAdapter.adsCallCount, 1);
        const shownAt = manager.getLastAdShownAt();
        assert.equal(shownAt > 0, true);

        // Второй вызов сразу же — блокируется кулдауном
        const secondResult = await manager.maybeShowInterstitialAd();
        assert.equal(secondResult, false);
        assert.equal(mockAdapter.adsCallCount, 1); // Вызов платформы не производился
        assert.equal(manager.getLastAdShownAt(), shownAt);
    });

    test("16. AdCooldownManager: сбой показа рекламы (throw) не обновляет lastAdShownAt и не блокирует повторную попытку", async () => {
        const failingAdapter = new MockPlatformAdapter({ adMockResult: false });
        const manager = new AdCooldownManager({ platformAdapter: failingAdapter, cooldownMs: 60000 });

        const failResult = await manager.maybeShowInterstitialAd();
        assert.equal(failResult, false);
        assert.equal(manager.getLastAdShownAt(), 0); // Время не обновлено

        // Сменяем адаптер на работающий — вызов сразу разрешается без ожидания 60с
        const workingAdapter = new MockPlatformAdapter();
        manager.setPlatformAdapter(workingAdapter);

        const successResult = await manager.maybeShowInterstitialAd();
        assert.equal(successResult, true);
        assert.equal(manager.getLastAdShownAt() > 0, true);
    });

    test("17. AdCooldownManager: результат рекламы { result: false } не обновляет lastAdShownAt", async () => {
        const rejectingAdapter = new MockPlatformAdapter({ adMockResult: { result: false } });
        const manager = new AdCooldownManager({ platformAdapter: rejectingAdapter, cooldownMs: 60000 });

        const rejectResult = await manager.maybeShowInterstitialAd();
        assert.equal(rejectResult, false);
        assert.equal(manager.getLastAdShownAt(), 0);
    });

    test("18. AdCooldownManager: показ рекламы разрешается после истечения 60 секунд", async () => {
        const mockAdapter = new MockPlatformAdapter();
        const manager = new AdCooldownManager({ platformAdapter: mockAdapter, cooldownMs: 60000 });

        const first = await manager.maybeShowInterstitialAd();
        assert.equal(first, true);

        // Имитируем прошествие 61 секунды
        manager.setLastAdShownAt(Date.now() - 61000);

        const afterCooldown = await manager.maybeShowInterstitialAd();
        assert.equal(afterCooldown, true);
        assert.equal(mockAdapter.adsCallCount, 2);
    });

    test("19. OnlineServerClient с VkBridgeAdapter без launchParams не подставляет dev_user_1 и отклоняет авторизацию", async () => {
        const vkAdapterNoParams = new VkBridgeAdapter({ launchParams: null, searchUrl: "" });
        const client = new OnlineServerClient({ platformAdapter: vkAdapterNoParams });

        assert.equal(client.launchParams, null);
        assert.equal(client.devUser, null);

        await assert.rejects(async () => {
            await client.authenticate();
        }, /Missing authentication credentials/);
    });
});
