/**
 * Платформенная интеграция TicTacToeA_VK: VkBridgeAdapter и MockPlatformAdapter.
 * 
 * Архитектурный принцип (DEC-010):
 * - В Development Mode используется MockPlatformAdapter (тестовые пользователи dev_user_1/2,
 *   мок рекламы и вступления в сообщество, отсутствие зависимости от реального VK Bridge).
 * - В VK Mini Apps Mode используется VkBridgeAdapter (настоящие вызовы @vkontakte/vk-bridge,
 *   запрет использования моковых данных и профилей).
 * - Авторитетная проверка параметров запуска (HMAC-SHA256) и выпуск токенов происходят
 *   исключительно на сервере через /api/auth. Клиентские адаптеры не проверяют подпись.
 */

"use strict";

/**
 * Базовый абстрактный класс платформенного адаптера.
 */
export class PlatformAdapter {
    get isMock() {
        return false;
    }

    get mode() {
        return "unknown";
    }

    async init() {
        throw new Error("init() must be implemented by platform adapter");
    }

    getLaunchParams() {
        return null;
    }

    getUserId() {
        return null;
    }

    async getUserInfo() {
        throw new Error("getUserInfo() must be implemented by platform adapter");
    }

    async showNativeAds() {
        throw new Error("showNativeAds() must be implemented by platform adapter");
    }

    async joinGroup() {
        throw new Error("joinGroup() must be implemented by platform adapter");
    }

    isBridgeAvailable() {
        return false;
    }
}

/**
 * Адаптер локальной среды разработки (Development Mode).
 * Предоставляет моковые реализации платформенных функций без внешних зависимостей.
 */
export class MockPlatformAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super();
        this.currentDevUser = config.devUser || this._detectDevUser();
        this.adsCallCount = 0;
        this.lastAdFormat = null;
        this.groupJoinCalls = [];
        this.adMockResult = config.adMockResult ?? true;
        this.groupMockResult = config.groupMockResult ?? true;
        this.initialized = false;
    }

    get isMock() {
        return true;
    }

    get mode() {
        return "development";
    }

    _detectDevUser() {
        if (typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            const fromUrl = params.get("dev_user");
            if (fromUrl) return fromUrl;
            try {
                const fromSession = sessionStorage.getItem("tictactoe_dev_user");
                if (fromSession) return fromSession;
            } catch {}
        }
        return "dev_user_1";
    }

    setDevUser(user) {
        if (user !== "dev_user_1" && user !== "dev_user_2") {
            throw new Error(`Unsupported dev user: ${user}. Allowed: dev_user_1, dev_user_2`);
        }
        this.currentDevUser = user;
        if (typeof window !== "undefined") {
            try {
                sessionStorage.setItem("tictactoe_dev_user", user);
            } catch {}
        }
    }

    async init() {
        this.initialized = true;
        return { result: true, mock: true };
    }

    getLaunchParams() {
        // В локальном Dev Mode реальных параметров запуска VK нет
        return null;
    }

    getUserId() {
        return this.currentDevUser;
    }

    async getUserInfo() {
        const isUser2 = this.currentDevUser === "dev_user_2";
        return {
            id: this.currentDevUser,
            first_name: isUser2 ? "Игрок 2" : "Игрок 1",
            last_name: "(Dev)",
            photo_200: null,
            is_mock: true
        };
    }

    async showNativeAds({ ad_format = "interstitial" } = {}) {
        this.adsCallCount += 1;
        this.lastAdFormat = ad_format;
        if (this.adMockResult === false) {
            throw new Error("Mock ad display failed");
        }
        return { result: true, mock: true, ad_format };
    }

    async joinGroup({ group_id = 0 } = {}) {
        this.groupJoinCalls.push({ group_id, at: Date.now() });
        if (this.groupMockResult === false) {
            throw new Error("Mock group join failed");
        }
        return { result: true, mock: true, group_id };
    }

    isBridgeAvailable() {
        return false;
    }
}

/**
 * Адаптер для реальной среды VK Mini Apps.
 * Взаимодействует с оболочкой VK через @vkontakte/vk-bridge (window.vkBridge).
 */
export class VkBridgeAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super();
        this._bridge = config.bridge || (typeof window !== "undefined" ? window.vkBridge : null);
        this._launchParams = config.launchParams || this._extractLaunchParams(config.searchUrl);
    }

    get isMock() {
        return false;
    }

    get mode() {
        return "vk_mini_apps";
    }

    _extractLaunchParams(customSearch = null) {
        if (customSearch) {
            return customSearch.startsWith("?") ? customSearch.slice(1) : customSearch;
        }
        if (typeof window !== "undefined") {
            const search = window.location.search;
            if (search && search.includes("vk_user_id=")) {
                return search.startsWith("?") ? search.slice(1) : search;
            }
        }
        return null;
    }

    _getBridge() {
        if (this._bridge) return this._bridge;
        if (typeof window !== "undefined" && window.vkBridge) {
            this._bridge = window.vkBridge;
            return this._bridge;
        }
        throw new Error("VK Bridge is not available in the current environment");
    }

    isBridgeAvailable() {
        return Boolean(this._bridge || (typeof window !== "undefined" && window.vkBridge));
    }

    async init() {
        const bridge = this._getBridge();
        return await bridge.send("VKWebAppInit");
    }

    getLaunchParams() {
        return this._launchParams;
    }

    getUserId() {
        if (!this._launchParams) return null;
        try {
            const params = new URLSearchParams(this._launchParams);
            return params.get("vk_user_id") || null;
        } catch {
            return null;
        }
    }

    async getUserInfo() {
        const bridge = this._getBridge();
        return await bridge.send("VKWebAppGetUserInfo");
    }

    async showNativeAds({ ad_format = "interstitial" } = {}) {
        const bridge = this._getBridge();
        return await bridge.send("VKWebAppShowNativeAds", { ad_format });
    }

    async joinGroup({ group_id } = {}) {
        if (!group_id) {
            throw new Error("PCP Games VK group ID is not configured");
        }
        const bridge = this._getBridge();
        return await bridge.send("VKWebAppJoinGroup", { group_id: Number(group_id) });
    }

    setDevUser() {
        throw new Error("Cannot set dev user in VK Mini Apps Mode");
    }
}

/**
 * Проверка, запущено ли приложение с параметрами запуска VK Mini Apps.
 */
export function isVkMiniAppsMode(searchUrl = null) {
    let search = searchUrl;
    if (search === null && typeof window !== "undefined") {
        search = window.location.search;
    }
    if (!search) return false;
    if (search.startsWith("?")) search = search.slice(1);
    try {
        const params = new URLSearchParams(search);
        return Boolean(params.get("vk_user_id") && params.get("vk_app_id"));
    } catch {
        return false;
    }
}

/**
 * Фабрика платформенного адаптера.
 * Автоматически выбирает VkBridgeAdapter или MockPlatformAdapter.
 */
export function createPlatformAdapter(config = {}) {
    if (config.forceMode === "vk_mini_apps") {
        return new VkBridgeAdapter(config);
    }
    if (config.forceMode === "development") {
        return new MockPlatformAdapter(config);
    }

    const search = config.searchUrl !== undefined
        ? config.searchUrl
        : (typeof window !== "undefined" ? window.location.search : "");

    if (isVkMiniAppsMode(search)) {
        return new VkBridgeAdapter({ ...config, searchUrl: search });
    }

    return new MockPlatformAdapter(config);
}
