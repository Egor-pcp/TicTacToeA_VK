import { OnlineClient } from "./online-client.js";
import { ONLINE_CONFIG } from "./online-config.js";

const MAX_LOG_ENTRIES = 100;
const MAX_MESSAGE_LENGTH = 1000;

const elements = {
    status: document.querySelector("#connection-status"),
    ownId: document.querySelector("#own-id"),
    peerId: document.querySelector("#peer-id"),
    connect: document.querySelector("#connect-button"),
    cancel: document.querySelector("#cancel-button"),
    messageForm: document.querySelector("#message-form"),
    messageInput: document.querySelector("#message-input"),
    send: document.querySelector("#send-button"),
    log: document.querySelector("#event-log"),
    clearLog: document.querySelector("#clear-log-button")
};

const client = new OnlineClient(ONLINE_CONFIG);
let searchStartedAt = null;
let searchClock = null;

function log(message, kind = "info") {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = new Date().toISOString();
    time.textContent = new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(new Date());
    item.dataset.kind = kind;
    item.append(time, document.createTextNode(message));
    elements.log.append(item);

    while (elements.log.children.length > MAX_LOG_ENTRIES) {
        elements.log.firstElementChild.remove();
    }
    elements.log.scrollTop = elements.log.scrollHeight;
}

function setStatus(message, state = "pending") {
    elements.status.textContent = message;
    elements.status.dataset.state = state;
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return [hours, minutes, seconds % 60]
        .map(value => String(value).padStart(2, "0"))
        .join(":");
}

function updateSearchStatus() {
    if (searchStartedAt === null ||
        !["searching", "pairing", "connecting"].includes(client.state)) {
        return;
    }

    const elapsed = formatDuration(Date.now() - searchStartedAt);
    const message = client.state === "searching"
        ? `Ищем игрока — ${elapsed}`
        : client.state === "pairing"
            ? `Подтверждаем пару — ${elapsed}`
            : `Устанавливаем WebRTC — ${elapsed}`;
    setStatus(message);
}

function startSearchClock() {
    stopSearchClock();
    searchStartedAt = Date.now();
    updateSearchStatus();
    searchClock = setInterval(updateSearchStatus, 1000);
}

function stopSearchClock() {
    if (searchClock !== null) {
        clearInterval(searchClock);
        searchClock = null;
    }
    searchStartedAt = null;
}

function updateControls() {
    const searching = ["searching", "pairing", "connecting"].includes(client.state);
    const connected = client.state === "connected" && client.isDataChannelOpen;

    elements.connect.disabled = searching;
    elements.cancel.hidden = !searching;
    elements.messageInput.disabled = !connected;
    elements.send.disabled = !connected;
}

client.on("welcome", ({ clientId }) => {
    elements.ownId.textContent = clientId;
    log(`Подключение зарегистрировано: ${clientId}`);
});

client.on("signalingopen", () => {
    log("WebSocket сигнализации подключён");
});

client.on("statechange", ({ state }) => {
    updateControls();
    if (["searching", "pairing", "connecting"].includes(state)) {
        updateSearchStatus();
    } else {
        stopSearchClock();
    }
});

client.on("searching", () => {
    setStatus("Подключено. Ищем игрока…");
    log("Добавлены в очередь поиска");
});

client.on("matchfound", ({ peerId }) => {
    elements.peerId.textContent = peerId;
    log(`Найден игрок ${peerId}; подтверждаем данные пары`);
});

client.on("matchstart", () => {
    log("Оба браузера подтвердили пару; начинаем WebRTC handshake");
});

client.on("signal", ({ signalType }) => {
    const messages = {
        "offer-sent": "SDP-предложение отправлено через сервер сигнализации",
        "offer-received": "SDP-предложение принято; ответ отправлен через сервер сигнализации",
        "answer-received": "SDP-ответ принят"
    };
    if (messages[signalType]) log(messages[signalType]);
});

client.on("peerconnectionstate", ({ state }) => {
    log(`PeerConnection: ${state}`);
});

client.on("datachannelopen", () => {
    stopSearchClock();
    setStatus("WebRTC DataChannel открыт — сообщения идут напрямую", "connected");
    log("DataChannel открыт. Сервер больше не участвует в передаче тестовых сообщений");
    updateControls();
    elements.messageInput.focus();
});

client.on("message", ({ data }) => {
    log(`Получено от ${client.peerId}: ${String(data)}`, "received");
});

client.on("cancelled", ({ hadMatch }) => {
    stopSearchClock();
    elements.peerId.textContent = "—";
    setStatus(hadMatch ? "Подключение отменено" : "Поиск отменён");
    log("Поиск отменён");
    updateControls();
});

client.on("peerleft", () => {
    stopSearchClock();
    elements.peerId.textContent = "—";
    setStatus("Соперник отключился", "error");
    log("Соперник отключился до открытия канала", "error");
    updateControls();
});

client.on("connectionlost", ({ wasActive }) => {
    if (!wasActive) return;
    stopSearchClock();
    elements.peerId.textContent = "—";
    setStatus("Сигнальное соединение закрыто", "error");
    log("Соединение с сервером сигнализации закрыто", "error");
    updateControls();
});

client.on("error", ({ message }) => {
    stopSearchClock();
    setStatus(message, "error");
    log(message, "error");
    updateControls();
});

function startSearch() {
    setStatus("Подключаемся к серверу сигнализации…");
    updateControls();
    const searchRequest = client.search();
    startSearchClock();
    searchRequest.catch(() => {
        updateControls();
    });
}

function cancelSearch() {
    client.cancel();
}

elements.connect.addEventListener("click", startSearch);
elements.cancel.addEventListener("click", cancelSearch);
elements.clearLog.addEventListener("click", () => elements.log.replaceChildren());

elements.messageForm.addEventListener("submit", event => {
    event.preventDefault();
    const message = elements.messageInput.value.trim();
    if (!message || message.length > MAX_MESSAGE_LENGTH || !client.isDataChannelOpen) {
        return;
    }
    try {
        client.send(message);
        log(`Отправлено: ${message}`, "sent");
        elements.messageInput.value = "";
        elements.messageInput.focus();
    } catch (error) {
        setStatus(`Не удалось отправить сообщение: ${error.message}`, "error");
        log(`Не удалось отправить сообщение: ${error.message}`, "error");
    }
});

window.addEventListener("pagehide", () => {
    stopSearchClock();
    client.disconnect();
});

updateControls();
