import { OnlineClient } from "../online-client.js";
import { ONLINE_CONFIG } from "../online-config.js";

const elements = {
    status: document.querySelector("#connection-status"),
    ownId: document.querySelector("#own-id"),
    peerId: document.querySelector("#peer-id"),
    connect: document.querySelector("#connect-button"),
    cancel: document.querySelector("#cancel-button"),
    messageForm: document.querySelector("#message-form"),
    messageInput: document.querySelector("#message-input"),
    send: document.querySelector("#send-button"),
    clearLog: document.querySelector("#clear-log-button"),
    log: document.querySelector("#event-log"),
    ice: document.querySelector("#ice-state"),
    peerState: document.querySelector("#peer-state"),
    candidatePair: document.querySelector("#candidate-pair"),
    localCandidate: document.querySelector("#local-candidate"),
    remoteCandidate: document.querySelector("#remote-candidate"),
    connectionType: document.querySelector("#connection-type"),
    summary: document.querySelector("#diagnostic-summary"),
    stats: document.querySelector("#stats-details"),
    copyReport: document.querySelector("#copy-report-button"),
    copyStatus: document.querySelector("#report-copy-status")
};

let client = null;
let report = null;
const IP_OR_SDP_PATTERN = /(?:\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:^|[\s[(])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?=$|[\s)\]])|(?:^|\n)(?:v=0|o=|s=|t=|a=(?:candidate|ice-pwd|ice-ufrag|fingerprint|setup):)|(?:credential|password|username)\s*[:=])/i;

function sanitizeText(value) {
    return String(value ?? "")
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP скрыт]")
        .replace(/(?:^|[\s[(])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?=$|[\s)\]])/gi, " [IP скрыт] ")
        .replace(/(?:^|\n)(?:v=0|o=|s=|t=|a=(?:candidate|ice-pwd|ice-ufrag|fingerprint|setup):)[^\r\n]*/gi, "[SDP line redacted]")
        .replace(/\b(username|credential|password|ice-pwd|ice-ufrag)\s*[:=]\s*[^\s,;]+/gi, "$1=[скрыто]")
        .replace(/(?:turns?|stun):[^\s/]*@/gi, "turn:[данные скрыты]@");
}

function nowMs() {
    return report ? Math.max(0, Math.round(performance.now() - report.startedAtMs)) : 0;
}

function log(message, type = "event") {
    const safeMessage = sanitizeText(message);
    const item = document.createElement("li");
    item.textContent = `+${(nowMs() / 1000).toFixed(3)} с — ${safeMessage}`;
    elements.log.append(item);
    while (elements.log.children.length > 500) elements.log.firstElementChild.remove();
    elements.log.scrollTop = elements.log.scrollHeight;
    if (report) report.events.push({ atMs: nowMs(), type, message: safeMessage });
}

function setStatus(message) {
    elements.status.textContent = sanitizeText(message);
}

function resetDiagnostics() {
    for (const element of [elements.ice, elements.peerState, elements.candidatePair,
        elements.localCandidate, elements.remoteCandidate, elements.connectionType]) {
        element.textContent = "—";
    }
}

function renderStats(snapshot, final = false, reason = null, lastWorkingSnapshot = null) {
    if (!snapshot) return;
    const { states, candidatePairs, candidateCounts, dataChannel } = snapshot;
    elements.ice.textContent = states.iceConnectionState;
    elements.peerState.textContent = `${states.connectionState} / DataChannel: ${states.dataChannelState}`;
    const selected = snapshot.selectedPair;
    elements.candidatePair.textContent = selected
        ? `${selected.state}; ${selected.localCandidateType} → ${selected.remoteCandidateType}; ${selected.connectionType}; nominated=${selected.nominated}; selected=${selected.selected}`
        : "Выбранная пара отсутствует";
    elements.localCandidate.textContent = selected?.localCandidateType ?? "—";
    elements.remoteCandidate.textContent = selected?.remoteCandidateType ?? "—";
    elements.connectionType.textContent = selected?.connectionType ?? "не определён";
    elements.stats.textContent = JSON.stringify({
        sampledAtMs: snapshot.sampledAtMs,
        final,
        reason,
        finalSnapshot: final ? snapshot : null,
        lastWorkingSnapshot,
        states,
        statesAtCompletion: snapshot.statesAtCompletion,
        candidateCounts,
        candidatePairs,
        dataChannel
    }, null, 2);
    updateSummary(final ? reason : null, snapshot);
}

function updateSummary(reason = null, snapshot = null) {
    if (!report) return;
    const latest = snapshot ?? report.latestStats ?? null;
    const ended = report.endedAtMs !== null;
    elements.summary.textContent = JSON.stringify({
        schemaVersion: 1,
        startedAt: report.startedAtIso,
        elapsedMs: ended ? report.endedAtMs : nowMs(),
        clientId: report.clientId,
        peerId: report.peerId,
        terminationReason: reason ?? report.terminationReason ?? (ended ? "ended" : "in-progress"),
        finalStates: report.finalStats?.statesAtCompletion ?? report.finalStats?.states ?? null,
        latestSnapshot: latest,
        finalSnapshot: report.finalStats,
        lastWorkingSnapshot: report.lastWorkingStats,
        candidateCounts: latest?.candidateCounts ?? null,
        selectedPair: latest?.selectedPair ?? null,
        allCandidatePairs: latest?.candidatePairs ?? [],
        eventCount: report.events.length,
        statsSnapshotCount: report.stats.length,
        privacyCheck: "IP, SDP and credentials are excluded"
    }, null, 2);
}

function beginReport() {
    report = {
        schemaVersion: 1,
        startedAtIso: new Date().toISOString(),
        startedAtEpochMs: Date.now(),
        startedAtMs: performance.now(),
        events: [],
        stats: [],
        clientId: null,
        peerId: null,
        terminationReason: null,
        endedAtMs: null,
        latestStats: null,
        finalStats: null,
        lastWorkingStats: null
    };
    elements.log.replaceChildren();
    elements.stats.textContent = "Ожидание статистики";
    elements.summary.textContent = "Подключение запущено";
}

function endReport(reason) {
    if (!report || report.endedAtMs !== null) return;
    report.endedAtMs = nowMs();
    report.terminationReason = reason;
    log(`Сеанс завершён: ${reason}`, "termination");
    updateSummary(reason);
}

function recordDiagnostic(diagnostic) {
    const safeDiagnostic = {
        ...diagnostic,
        message: diagnostic.message ? sanitizeText(diagnostic.message) : undefined,
        errorText: diagnostic.errorText ? sanitizeText(diagnostic.errorText) : undefined
    };
    log(JSON.stringify(safeDiagnostic), "diagnostic");
}

function updateIdleControls() {
    elements.connect.textContent = "ВКЛ";
    elements.connect.disabled = false;
    elements.cancel.hidden = true;
    elements.cancel.textContent = "Отменить поиск";
    elements.messageInput.disabled = true;
    elements.send.disabled = true;
    resetDiagnostics();
}

async function disposeClient() {
    const previousClient = client;
    if (!previousClient) return;
    await previousClient.dispose();
    if (client === previousClient) client = null;
}

async function startSearch() {
    if (client) return;
    beginReport();
    resetDiagnostics();
    elements.ownId.textContent = "подключение…";
    elements.peerId.textContent = "—";
    elements.connect.disabled = true;
    setStatus("Подключаемся к Worker…");

    const activeClient = new OnlineClient(ONLINE_CONFIG);
    client = activeClient;
    const isCurrent = () => client === activeClient;

    activeClient.on("welcome", ({ clientId }) => {
        if (!isCurrent()) return;
        elements.ownId.textContent = clientId;
        report.clientId = clientId;
        log("Подключение к Worker установлено");
        updateSummary();
    });
    activeClient.on("searching", () => {
        if (!isCurrent()) return;
        setStatus("Ищем второго клиента…");
        elements.cancel.hidden = false;
        log("Поиск начат");
    });
    activeClient.on("matchfound", ({ peerId }) => {
        if (!isCurrent()) return;
        elements.peerId.textContent = peerId;
        report.peerId = peerId;
        setStatus("Клиент найден. Устанавливаем WebRTC…");
        log("Найден второй клиент");
        updateSummary();
    });
    activeClient.on("matchstart", () => {
        if (!isCurrent()) return;
        setStatus("Создаём PeerConnection…");
        log("Начата настройка WebRTC");
    });
    activeClient.on("diagnostic", recordDiagnostic);
    activeClient.on("stats", ({ snapshot, final, reason, lastWorkingSnapshot }) => {
        if (!isCurrent() || !snapshot) return;
        report.latestStats = snapshot;
        if (final) report.finalStats = snapshot;
        if (lastWorkingSnapshot) report.lastWorkingStats = lastWorkingSnapshot;
        else if (!final && snapshot.states.dataChannelState === "open" &&
            snapshot.statesAtCompletion.dataChannelState === "open") report.lastWorkingStats = snapshot;
        report.stats.push({
            final,
            reason: reason ?? null,
            finalSnapshot: final ? snapshot : null,
            lastWorkingSnapshot: report.lastWorkingStats,
            snapshot
        });
        renderStats(snapshot, final, reason, report.lastWorkingStats);
    });
    activeClient.on("peerconnectionstate", ({ state }) => {
        if (!isCurrent()) return;
        log(`PeerConnection: ${state}`);
    });
    activeClient.on("datachannelopen", () => {
        if (!isCurrent()) return;
        setStatus("DataChannel открыт");
        elements.messageInput.disabled = false;
        elements.send.disabled = false;
        elements.cancel.textContent = "Закрыть соединение";
        log("DataChannel открыт; отправляем контрольное сообщение");
        try {
            activeClient.send(`Тестовое сообщение от ${activeClient.clientId}`);
            log("Контрольное сообщение отправлено");
        } catch (error) {
            log(`Не удалось отправить контрольное сообщение: ${error.message}`);
        }
    });
    activeClient.on("message", ({ data }) => {
        if (!isCurrent()) return;
        const size = typeof data === "string" ? new TextEncoder().encode(data).length : 0;
        log(`Получено сообщение по DataChannel (${size} байт)`);
    });
    activeClient.on("cancelled", ({ reason }) => {
        if (!isCurrent()) return;
        const actualReason = reason ?? "user-cancelled";
        endReport(actualReason);
        setStatus("Поиск отменён");
        log("Worker подтвердил отмену поиска");
    });
    activeClient.on("peerleft", async ({ reason }) => {
        if (!isCurrent()) return;
        endReport(reason ?? "peer-disconnected");
        setStatus("Второй клиент отключился");
        log("Второй клиент отключился");
        await disposeClient();
        updateIdleControls();
    });
    activeClient.on("connectionlost", async ({ reason }) => {
        if (!isCurrent()) return;
        endReport(reason ?? "signaling-lost");
        setStatus("Соединение с Worker потеряно");
        await disposeClient();
        updateIdleControls();
    });
    activeClient.on("failure", ({ reason, message }) => {
        if (!isCurrent()) return;
        endReport(reason ?? "failure");
        setStatus(`Завершено: ${reason}${message ? ` — ${sanitizeText(message)}` : ""}`);
    });
    activeClient.on("error", ({ message, reason }) => {
        if (!isCurrent()) return;
        setStatus(`Ошибка: ${sanitizeText(message)}`);
        log(`Ошибка (${reason ?? "unspecified"}): ${sanitizeText(message)}`, "error");
        elements.cancel.hidden = false;
        elements.cancel.textContent = "Закрыть и повторить";
        endReport(reason ?? "error");
    });

    elements.cancel.hidden = false;
    try {
        await activeClient.search();
        if (isCurrent() && activeClient.state !== "idle") {
            elements.connect.textContent = "ВЫКЛ";
            elements.connect.disabled = false;
            if (activeClient.clientId) elements.ownId.textContent = activeClient.clientId;
        }
    } catch (error) {
        if (!isCurrent()) return;
        setStatus(`Ошибка: ${sanitizeText(error.message)}`);
        log(`Ошибка подключения: ${sanitizeText(error.message)}`, "error");
        elements.connect.disabled = false;
        elements.cancel.hidden = false;
        elements.cancel.textContent = "Закрыть и повторить";
        endReport("signaling-error");
    }
}

elements.connect.addEventListener("click", async () => {
    if (client) {
        await disposeClient();
        endReport("user-cancelled");
        setStatus("Отключено. Можно подключиться снова.");
        updateIdleControls();
        return;
    }
    void startSearch();
});

elements.cancel.addEventListener("click", async () => {
    if (!client) return;
    await disposeClient();
    endReport("user-cancelled");
    setStatus("Поиск отменён. Можно начать снова.");
    updateIdleControls();
});

elements.messageForm.addEventListener("submit", event => {
    event.preventDefault();
    const message = elements.messageInput.value.trim();
    if (!client?.isDataChannelOpen || !message) return;
    try {
        client.send(message);
        const size = new TextEncoder().encode(message).length;
        log(`Отправлено сообщение по DataChannel (${size} байт)`);
        elements.messageInput.value = "";
    } catch (error) {
        log(`Не удалось отправить сообщение: ${sanitizeText(error.message)}`, "error");
    }
});

elements.clearLog.addEventListener("click", () => elements.log.replaceChildren());
elements.copyReport.addEventListener("click", async () => {
    if (!report) {
        elements.copyStatus.textContent = "Сначала запустите подключение.";
        return;
    }
    const output = JSON.stringify(report, null, 2);
    if (IP_OR_SDP_PATTERN.test(output)) {
        elements.copyStatus.textContent = "Копирование остановлено: найдены данные, которые следует скрыть.";
        return;
    }
    try {
        await navigator.clipboard.writeText(output);
    } catch {
        const temporary = document.createElement("textarea");
        temporary.value = output;
        temporary.style.position = "fixed";
        temporary.style.opacity = "0";
        document.body.append(temporary);
        temporary.select();
        const copied = document.execCommand("copy");
        temporary.remove();
        if (!copied) {
            elements.copyStatus.textContent = "Не удалось скопировать. Разрешите Clipboard или откройте страницу по HTTPS.";
            return;
        }
    }
    elements.copyStatus.textContent = "Отчёт скопирован. IP-адреса, SDP и credentials не включаются.";
});
