const OPEN = 1;
const CONNECTING = 0;
const ACTIVE_STATES = new Set([
    "searching",
    "pairing",
    "connecting",
    "connected"
]);

function sanitizeDiagnosticText(value) {
    return String(value ?? "")
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP redacted]")
        .replace(/(?:^|[\s[(])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?=$|[\s)\]])/gi, "[IP redacted]")
        .replace(/(?:^|\n)(?:v=0|o=|s=|t=|a=(?:candidate|ice-pwd|ice-ufrag|fingerprint|setup):)[^\r\n]*/gi, "[SDP line redacted]")
        .replace(/\b(username|credential|password|ice-pwd|ice-ufrag)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
        .replace(/(?:turns?|stun):[^\s/]*@/gi, "turn:[redacted]@");
}

function getCandidateSummary(candidate) {
    const candidateLine = typeof candidate?.candidate === "string" ? candidate.candidate : "";
    const protocol = candidate?.protocol ?? candidateLine.match(/\b(?:udp|tcp)\b/i)?.[0]?.toLowerCase();
    const type = candidate?.type ?? candidateLine.match(/\btyp\s+(host|srflx|prflx|relay)\b/i)?.[1];
    return {
        type: type ?? "unknown",
        protocol: protocol ?? "unknown"
    };
}

function createDetailEvent(type, detail = {}) {
    return new CustomEvent(type, { detail });
}

export class OnlineClient extends EventTarget {
    #signalingUrl;
    #rtcConfiguration;
    #connectionTimeoutMs;
    #heartbeatIntervalMs;
    #socket = null;
    #socketPromise = null;
    #peerConnection = null;
    #dataChannel = null;
    #clientId = null;
    #peerId = null;
    #pendingMatch = null;
    #state = "idle";
    #heartbeat = null;
    #connectionTimeout = null;
    #queuedIceCandidates = [];
    #cancelAcksPending = 0;
    #disposed = false;
    #startedAt = null;
    #peerStartedAt = null;
    #diagnosticSequence = 0;
    #signalSequence = 0;
    #statsTimer = null;
    #statsRequest = null;
    #lastWorkingSnapshot = null;
    #terminationPromise = null;
    #lastTerminationReason = null;
    #signalAckTimers = new Map();

    constructor({
        signalingUrl,
        rtcConfiguration = { iceServers: [] },
        connectionTimeoutMs = 35_000,
        heartbeatIntervalMs = 15_000
    } = {}) {
        super();

        if (typeof signalingUrl !== "string" || signalingUrl.length === 0) {
            throw new TypeError("Не задан адрес WebSocket-сигнализации");
        }

        const url = new URL(signalingUrl);
        if (url.protocol !== "ws:" && url.protocol !== "wss:") {
            throw new TypeError("Адрес сигнализации должен использовать ws: или wss:");
        }

        this.#signalingUrl = url.href;
        this.#rtcConfiguration = rtcConfiguration;
        this.#connectionTimeoutMs = connectionTimeoutMs;
        this.#heartbeatIntervalMs = heartbeatIntervalMs;
    }

    get state() {
        return this.#state;
    }

    get clientId() {
        return this.#clientId;
    }

    get peerId() {
        return this.#peerId;
    }

    get match() {
        return this.#pendingMatch ? { ...this.#pendingMatch } : null;
    }

    get isDataChannelOpen() {
        return this.#dataChannel?.readyState === "open";
    }

    get lastTerminationReason() {
        return this.#lastTerminationReason;
    }

    async getConnectionStats(connection = this.#peerConnection, dataChannel = this.#dataChannel) {
        if (!connection) return null;

        const stateAtRequest = this.#readConnectionStates(connection, dataChannel);
        const sampledAtMs = this.#elapsedMs();
        const reports = await connection.getStats();
        const statesAtCompletion = this.#readConnectionStates(connection, dataChannel);
        const stats = [...reports.values()];
        const transport = stats.find(report =>
            report.type === "transport" && report.selectedCandidatePairId
        );
        const localCandidates = stats.filter(report => report.type === "local-candidate");
        const remoteCandidates = stats.filter(report => report.type === "remote-candidate");
        const candidatePairs = stats
            .filter(report => report.type === "candidate-pair")
            .map((pair, index) => {
                const localCandidate = localCandidates.find(report => report.id === pair.localCandidateId);
                const remoteCandidate = remoteCandidates.find(report => report.id === pair.remoteCandidateId);
                const selected = Boolean(transport && transport.selectedCandidatePairId === pair.id) ||
                    pair.selected === true;
                const candidateTypes = [localCandidate?.candidateType, remoteCandidate?.candidateType];
                const connectionType = candidateTypes.includes("relay")
                    ? "relay"
                    : candidateTypes.includes("srflx")
                        ? "srflx"
                        : candidateTypes.every(type => type === "host")
                            ? "host"
                            : "unknown";

                return {
                    index: index + 1,
                    state: pair.state ?? "unknown",
                    nominated: Boolean(pair.nominated),
                    selected,
                    localCandidateType: localCandidate?.candidateType ?? "unknown",
                    remoteCandidateType: remoteCandidate?.candidateType ?? "unknown",
                    localProtocol: localCandidate?.protocol ?? "unknown",
                    remoteProtocol: remoteCandidate?.protocol ?? "unknown",
                    connectionType,
                    packetsSent: pair.packetsSent ?? null,
                    packetsReceived: pair.packetsReceived ?? null,
                    bytesSent: pair.bytesSent ?? null,
                    bytesReceived: pair.bytesReceived ?? null,
                    requestsSent: pair.requestsSent ?? null,
                    requestsReceived: pair.requestsReceived ?? null,
                    responsesSent: pair.responsesSent ?? null,
                    responsesReceived: pair.responsesReceived ?? null,
                    currentRoundTripTime: pair.currentRoundTripTime ?? null
                };
            });

        const selectedPair = candidatePairs.find(pair => pair.selected) ?? null;
        const candidateCounts = candidates => candidates.reduce((counts, candidate) => {
            const key = candidate.candidateType ?? "unknown";
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
        }, {});
        const dataChannelStats = stats
            .filter(report => report.type === "data-channel")
            .map(report => ({
                state: report.state ?? stateAtRequest.dataChannelState,
                messagesSent: report.messagesSent ?? null,
                messagesReceived: report.messagesReceived ?? null,
                bytesSent: report.bytesSent ?? null,
                bytesReceived: report.bytesReceived ?? null
            }));

        return {
            sampledAtMs,
            states: stateAtRequest,
            statesAtCompletion,
            selectedPair,
            candidatePairs,
            candidateCounts: {
                local: candidateCounts(localCandidates),
                remote: candidateCounts(remoteCandidates)
            },
            dataChannel: dataChannelStats
        };
    }

    #elapsedMs() {
        return this.#startedAt === null
            ? 0
            : Math.max(0, Math.round(performance.now() - this.#startedAt));
    }

    #readConnectionStates(connection = this.#peerConnection, dataChannel = this.#dataChannel) {
        return {
            signalingState: connection?.signalingState ?? "unavailable",
            iceGatheringState: connection?.iceGatheringState ?? "unavailable",
            iceConnectionState: connection?.iceConnectionState ?? "unavailable",
            connectionState: connection?.connectionState ?? "unavailable",
            dataChannelState: dataChannel?.readyState ?? "unavailable"
        };
    }

    #emitDiagnostic(event, details = {}) {
        this.#emit("diagnostic", {
            sequence: ++this.#diagnosticSequence,
            atMs: this.#elapsedMs(),
            connectionAtMs: this.#peerStartedAt === null
                ? null
                : Math.max(0, Math.round(performance.now() - this.#peerStartedAt)),
            event,
            ...details
        });
    }

    #runRtcOperation(operation, callback, details = {}) {
        const startedAt = this.#elapsedMs();
        this.#emitDiagnostic("rtc-operation-start", { operation, ...details });
        return Promise.resolve()
            .then(callback)
            .then(result => {
                this.#emitDiagnostic("rtc-operation-ok", {
                    operation,
                    durationMs: this.#elapsedMs() - startedAt,
                    ...details
                });
                return result;
            }, error => {
                this.#emitDiagnostic("rtc-operation-error", {
                    operation,
                    errorName: error?.name ?? "Error",
                    message: sanitizeDiagnosticText(error?.message ?? error),
                    durationMs: this.#elapsedMs() - startedAt,
                    ...details
                });
                throw error;
            });
    }

    #sendSignal(matchId, signalType, payload) {
        const signalId = `${this.#clientId ?? "client"}-${++this.#signalSequence}`;
        this.#emitDiagnostic("signal-send", { signalId, signalType, matchId });
        this.#sendControl({ type: "signal", matchId, signalType, signalId, payload });
        const timer = setTimeout(() => {
            this.#signalAckTimers.delete(signalId);
            this.#emitDiagnostic("worker-relay-ack-timeout", { signalId, signalType, matchId });
        }, 5000);
        this.#signalAckTimers.set(signalId, timer);
    }

    #stopStatsPolling() {
        if (this.#statsTimer !== null) clearInterval(this.#statsTimer);
        this.#statsTimer = null;
    }

    #startStatsPolling(connection, dataChannel = this.#dataChannel) {
        this.#stopStatsPolling();
        let samplePending = false;
        const sample = async () => {
            if (samplePending || this.#peerConnection !== connection || connection.signalingState === "closed") return;
            samplePending = true;
            const request = this.getConnectionStats(connection, dataChannel)
                .then(snapshot => {
                    if (snapshot.states.dataChannelState === "open" &&
                        snapshot.statesAtCompletion.dataChannelState === "open" &&
                        dataChannel?.readyState === "open" &&
                        snapshot.statesAtCompletion.connectionState !== "closed") {
                        this.#lastWorkingSnapshot = snapshot;
                    }
                    this.#emit("stats", { snapshot, final: false });
                })
                .catch(error => this.#emitDiagnostic("getStats-error", {
                    errorName: error?.name ?? "Error",
                    message: sanitizeDiagnosticText(error?.message ?? error)
                }));
            this.#statsRequest = request;
            try {
                await request;
            } finally {
                if (this.#statsRequest === request) this.#statsRequest = null;
                samplePending = false;
            }
        };
        sample();
        this.#statsTimer = setInterval(sample, 1000);
    }

    #terminate({ reason, message = "", event = "failure", details = {}, notifyWorker = false } = {}) {
        if (this.#terminationPromise) return this.#terminationPromise;
        const connection = this.#peerConnection;
        const dataChannel = this.#dataChannel;
        const matchId = this.#pendingMatch?.matchId;
        this.#lastTerminationReason = reason;
        this.#stopStatsPolling();
        this.#clearConnectionTimeout();
        for (const timer of this.#signalAckTimers.values()) clearTimeout(timer);
        this.#signalAckTimers.clear();

        if (notifyWorker && this.#socket?.readyState === OPEN) {
            this.#cancelAcksPending += 1;
            try {
                this.#sendControl({ type: "cancel", matchId });
            } catch (error) {
                this.#emitDiagnostic("worker-cancel-send-error", {
                    message: sanitizeDiagnosticText(error?.message ?? error)
                });
            }
        } else if (notifyWorker && this.#socket?.readyState === CONNECTING) {
            const connectingSocket = this.#socket;
            this.#socket = null;
            this.#socketPromise = null;
            this.#stopHeartbeat();
            connectingSocket.close(1000, "Search cancelled before signaling connected");
        }

        this.#setState("idle", { reason });
        this.#terminationPromise = (async () => {
            if (this.#statsRequest) await this.#statsRequest;
            const lastWorkingSnapshot = this.#lastWorkingSnapshot;
            if (connection) {
                try {
                    const snapshot = await this.getConnectionStats(connection, dataChannel);
                    this.#emit("stats", {
                        snapshot,
                        final: true,
                        reason,
                        lastWorkingSnapshot
                    });
                    this.#emitDiagnostic("final-stats", {
                        reason,
                        finalSnapshot: snapshot,
                        lastWorkingSnapshot
                    });
                } catch (error) {
                    this.#emitDiagnostic("final-stats-error", {
                        reason,
                        message: sanitizeDiagnosticText(error?.message ?? error)
                    });
                }
            }
            this.#resetPeerConnection();
            this.#pendingMatch = null;
            this.#peerId = null;
            this.#emitDiagnostic("session-ended", { reason, message: sanitizeDiagnosticText(message) });
            this.#emit(event, { ...details, reason, message: sanitizeDiagnosticText(message) });
            if (event === "failure") {
                const error = new Error(message || `Connection ended: ${reason}`);
                this.#emit("error", { error, message: error.message, reason });
            }
        })().finally(() => {
            this.#terminationPromise = null;
        });
        return this.#terminationPromise;
    }

    on(type, listener, options) {
        const wrappedListener = event => listener(event.detail, event);
        this.addEventListener(type, wrappedListener, options);
        return () => this.removeEventListener(type, wrappedListener, options);
    }

    async connect() {
        this.#assertNotDisposed();
        if (this.#socket?.readyState === OPEN) return;
        if (this.#socket?.readyState === CONNECTING && this.#socketPromise) {
            return this.#socketPromise;
        }

        let url;
        try {
            url = this.#signalingUrl;
            const socket = new WebSocket(url);
            this.#socket = socket;

            this.#socketPromise = new Promise((resolve, reject) => {
                let settled = false;
                let messageQueue = Promise.resolve();
                const settle = (callback, value) => {
                    if (settled) return;
                    settled = true;
                    callback(value);
                };

                socket.addEventListener("open", () => {
                    if (this.#socket !== socket) return;
                    this.#startHeartbeat();
                    this.#emit("signalingopen", { url });
                    this.#emitDiagnostic("signaling-open");
                    settle(resolve);
                });
                socket.addEventListener("message", event => {
                    messageQueue = messageQueue
                        .then(() => {
                            if (this.#socket !== socket || this.#terminationPromise) return;
                            return this.#handleSocketMessage(event);
                        })
                        .catch(error => {
                            this.#failPair(error, "signaling-error");
                        });
                });
                socket.addEventListener("error", () => {
                    const error = new Error("Ошибка WebSocket-соединения с сервером");
                    if (!settled) {
                        settle(reject, error);
                    } else {
                        this.#emit("error", { error, message: error.message });
                    }
                });
                socket.addEventListener("close", () => {
                    if (!settled) {
                        settle(reject, new Error("Сигнальное соединение закрыто до подключения"));
                    }
                    this.#handleSocketClose(socket);
                });
            });
        } catch (error) {
            this.#socket = null;
            throw error;
        }

        return this.#socketPromise;
    }

    async search(options = {}) {
        this.#assertNotDisposed();
        if (this.#terminationPromise) await this.#terminationPromise;
        if (this.#state === "connected") {
            this.cancel();
            if (this.#terminationPromise) await this.#terminationPromise;
        }
        if (ACTIVE_STATES.has(this.#state)) {
            throw new Error("Поиск или соединение уже выполняется");
        }

        this.#startedAt = performance.now();
        this.#peerStartedAt = null;
        this.#lastWorkingSnapshot = null;
        this.#diagnosticSequence = 0;
        this.#signalSequence = 0;
        this.#lastTerminationReason = null;
        this.#resetPeerConnection();
        this.#pendingMatch = null;
        this.#peerId = null;
        this.#setState("searching");
        this.#emitDiagnostic("search-start", { clientId: this.#clientId });

        try {
            await this.connect();
            if (this.#state !== "searching") return false;
            this.#sendControl({ ...options, type: "search" });
            return true;
        } catch (error) {
            if (this.#state === "idle" && this.#lastTerminationReason === "user-cancelled") return false;
            this.#failPair(error, "signaling-error");
            throw error;
        }
    }

    cancel() {
        if (this.#disposed || !ACTIVE_STATES.has(this.#state)) return false;

        const hadMatch = this.#pendingMatch !== null;
        this.#terminate({
            reason: "user-cancelled",
            event: "cancelled",
            details: { hadMatch },
            notifyWorker: true
        });
        return true;
    }

    send(data) {
        if (!this.isDataChannelOpen) {
            throw new Error("WebRTC DataChannel не открыт");
        }

        const payload = typeof data === "string" ? data : JSON.stringify(data);
        if (typeof payload !== "string") {
            throw new TypeError("Сообщение нельзя преобразовать в текст");
        }
        this.#dataChannel.send(payload);
    }

    async disconnect() {
        if (this.#disposed) return;

        if (ACTIVE_STATES.has(this.#state)) {
            this.cancel();
        }
        if (this.#terminationPromise) await this.#terminationPromise;
        this.#stopHeartbeat();
        this.#resetPeerConnection();

        const socket = this.#socket;
        this.#socket = null;
        this.#socketPromise = null;
        this.#cancelAcksPending = 0;
        if (socket && socket.readyState < WebSocket.CLOSING) {
            socket.close(1000, "Client disconnected");
        }
        this.#setState("idle");
        this.#emit("disconnect", {});
    }

    async dispose() {
        if (this.#disposed) return;
        await this.disconnect();
        this.#disposed = true;
    }

    #assertNotDisposed() {
        if (this.#disposed) {
            throw new Error("OnlineClient уже закрыт");
        }
    }

    #emit(type, detail) {
        this.dispatchEvent(createDetailEvent(type, detail));
    }

    #setState(state, detail = {}) {
        if (this.#state === state) return;
        const previousState = this.#state;
        this.#state = state;
        this.#emit("statechange", { state, previousState, ...detail });
    }

    #sendControl(message) {
        if (!this.#socket || this.#socket.readyState !== OPEN) {
            throw new Error("Сигнальное соединение с сервером недоступно");
        }
        this.#socket.send(JSON.stringify(message));
    }

    #startHeartbeat() {
        this.#stopHeartbeat();
        this.#heartbeat = setInterval(() => {
            if (this.#socket?.readyState !== OPEN) return;
            try {
                this.#sendControl({ type: "heartbeat" });
            } catch (error) {
                this.#emit("error", { error, message: error.message });
            }
        }, this.#heartbeatIntervalMs);
    }

    #stopHeartbeat() {
        if (this.#heartbeat === null) return;
        clearInterval(this.#heartbeat);
        this.#heartbeat = null;
    }

    #clearConnectionTimeout() {
        if (this.#connectionTimeout === null) return;
        clearTimeout(this.#connectionTimeout);
        this.#connectionTimeout = null;
    }

    #resetPeerConnection() {
        this.#clearConnectionTimeout();
        this.#stopStatsPolling();
        this.#queuedIceCandidates = [];

        if (this.#dataChannel) {
            const channel = this.#dataChannel;
            channel.onopen = null;
            channel.onclose = () => this.#emitDiagnostic("datachannel-state-change", {
                readyState: channel.readyState
            });
            channel.onerror = null;
            channel.onmessage = null;
            this.#emitDiagnostic("datachannel-close-requested", { readyState: channel.readyState });
            channel.close();
            this.#emitDiagnostic("datachannel-state-change", { readyState: channel.readyState });
            this.#dataChannel = null;
        }

        if (this.#peerConnection) {
            this.#peerConnection.onicecandidate = null;
            this.#peerConnection.onicecandidateerror = null;
            this.#peerConnection.onsignalingstatechange = null;
            this.#peerConnection.onicegatheringstatechange = null;
            this.#peerConnection.oniceconnectionstatechange = null;
            this.#peerConnection.onconnectionstatechange = null;
            this.#peerConnection.ondatachannel = null;
            this.#peerConnection.close();
            this.#peerConnection = null;
        }
    }

    #handleSocketClose(socket) {
        if (this.#socket !== socket) return;

        this.#socket = null;
        this.#socketPromise = null;
        this.#stopHeartbeat();
        const wasActive = ACTIVE_STATES.has(this.#state);
        this.#emitDiagnostic("signaling-socket-closed", { wasActive });
        this.#terminate({ reason: "signaling-lost", event: "connectionlost", details: { wasActive } });
    }

    async #handleSocketMessage(event) {
        if (typeof event.data !== "string") {
            throw new Error("Получено неподдерживаемое бинарное сообщение сигнализации");
        }

        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            throw new Error("Сервер прислал некорректный JSON");
        }

        this.#emitDiagnostic("websocket-message", {
            messageType: message.type,
            matchId: typeof message.matchId === "string" ? message.matchId : undefined,
            signalType: typeof message.signalType === "string" ? message.signalType : undefined,
            signalId: typeof message.signalId === "string" ? message.signalId : undefined
        });

        await this.#handleServerMessage(message);
    }

    async #handleServerMessage(message) {
        if (!message || typeof message !== "object" || typeof message.type !== "string") {
            throw new Error("Некорректное сообщение сервера");
        }

        if (message.type === "welcome") {
            if (typeof message.clientId !== "string" || message.clientId.length === 0) {
                throw new Error("Сервер не выдал корректный ID подключения");
            }
            this.#clientId = message.clientId;
            this.#emit("welcome", { clientId: this.#clientId });
            return;
        }

        if (message.type === "searching") {
            this.#setState("searching");
            this.#emit("searching", {});
            return;
        }

        if (message.type === "match-found") {
            if (!this.#isValidMatch(message)) {
                throw new Error("Сервер прислал неполные данные пары");
            }
            if (this.#pendingMatch?.matchId === message.matchId) {
                this.#sendControl({ type: "ready", matchId: message.matchId });
                return;
            }
            if (this.#pendingMatch) {
                throw new Error("Сервер прислал вторую пару до завершения первой");
            }

            this.#pendingMatch = {
                matchId: message.matchId,
                peerId: message.peerId,
                initiator: message.initiator
            };
            this.#peerId = message.peerId;
            this.#setState("pairing");
            this.#emit("matchfound", { ...this.#pendingMatch });
            this.#sendControl({ type: "ready", matchId: message.matchId });
            return;
        }

        if (message.type === "match-start") {
            if (!this.#isValidMatch(message) ||
                this.#pendingMatch?.matchId !== message.matchId ||
                this.#pendingMatch.peerId !== message.peerId ||
                this.#pendingMatch.initiator !== message.initiator) {
                throw new Error("Старт не соответствует подтверждённым данным пары");
            }
            this.#emit("matchstart", { ...this.#pendingMatch });
            await this.#createPeerConnection(this.#pendingMatch);
            return;
        }

        if (message.type === "signal") {
            await this.#handleSignal(message);
            return;
        }

        if (message.type === "signal-ack") {
            const timer = this.#signalAckTimers.get(message.signalId);
            if (timer !== undefined) {
                clearTimeout(timer);
                this.#signalAckTimers.delete(message.signalId);
            }
            this.#emitDiagnostic("worker-relay-ack", {
                signalId: message.signalId,
                signalType: message.signalType,
                delivered: message.delivered === true,
                reason: message.delivered === true ? null : message.reason ?? "delivery-failed"
            });
            return;
        }

        if (message.type === "cancelled") {
            const acknowledgesLocalCancel = this.#cancelAcksPending > 0;
            if (acknowledgesLocalCancel) this.#cancelAcksPending -= 1;

            if (ACTIVE_STATES.has(this.#state) || acknowledgesLocalCancel || this.#terminationPromise) {
                return;
            }
            this.#resetPeerConnection();
            this.#pendingMatch = null;
            this.#peerId = null;
            this.#setState("idle");
            this.#emit("diagnostic", {
                sequence: ++this.#diagnosticSequence,
                atMs: this.#elapsedMs(),
                event: "unexpected-worker-cancel-ack"
            });
            return;
        }

        if (message.type === "match-timeout") {
            this.#terminate({
                reason: "timeout",
                message: "Истекло время настройки пары; можно начать поиск заново",
                event: "failure"
            });
            return;
        }

        if (message.type === "peer-left") {
            this.#terminate({ reason: "peer-disconnected", event: "peerleft" });
            return;
        }

        if (message.type === "error") {
            throw new Error(typeof message.message === "string"
                ? message.message
                : "Ошибка сервера сигнализации");
        }

        throw new Error(`Неизвестное сообщение сервера: ${message.type}`);
    }

    #isValidMatch(message) {
        return typeof message.matchId === "string" &&
            message.matchId.length > 0 &&
            typeof message.peerId === "string" &&
            message.peerId.length > 0 &&
            typeof message.initiator === "boolean" &&
            message.peerId !== this.#clientId;
    }

    async #drainIceCandidates(connection) {
        const candidates = this.#queuedIceCandidates;
        this.#queuedIceCandidates = [];
        for (const candidate of candidates) {
            const candidateInfo = getCandidateSummary(candidate);
            this.#emitDiagnostic("remote-ice-queued-drain", candidateInfo);
            await this.#runRtcOperation("addIceCandidate", () => connection.addIceCandidate(candidate), candidateInfo);
            this.#emitDiagnostic("remote-ice-added", { ...candidateInfo, result: "success" });
        }
    }

    async #handleSignal(message) {
        const connection = this.#peerConnection;
        if (!connection || message.matchId !== this.#pendingMatch?.matchId) {
            throw new Error("Получен сигнал для неизвестной пары");
        }

        this.#emitDiagnostic("signal-received-from-worker", {
            signalType: message.signalType,
            signalId: message.signalId ?? null,
            matchId: message.matchId
        });

        if (message.signalType === "offer") {
            if (this.#pendingMatch.initiator || !message.description ||
                message.description.type !== "offer" ||
                typeof message.description.sdp !== "string") {
                throw new Error("Получено некорректное SDP-предложение");
            }
            await this.#runRtcOperation("setRemoteDescription(offer)", () =>
                connection.setRemoteDescription(message.description));
            await this.#drainIceCandidates(connection);
            const answer = await this.#runRtcOperation("createAnswer", () => connection.createAnswer());
            await this.#runRtcOperation("setLocalDescription(answer)", () =>
                connection.setLocalDescription(answer));
            this.#sendSignal(this.#pendingMatch.matchId, "answer", connection.localDescription);
            this.#emit("signal", { signalType: "offer-received" });
            return;
        }

        if (message.signalType === "answer") {
            if (!this.#pendingMatch.initiator || !message.description ||
                message.description.type !== "answer" ||
                typeof message.description.sdp !== "string") {
                throw new Error("Получен некорректный SDP-ответ");
            }
            await this.#runRtcOperation("setRemoteDescription(answer)", () =>
                connection.setRemoteDescription(message.description));
            await this.#drainIceCandidates(connection);
            this.#emit("signal", { signalType: "answer-received" });
            return;
        }

        if (message.signalType === "ice") {
            if (!message.candidate || typeof message.candidate !== "object") {
                throw new Error("Получен некорректный ICE-кандидат");
            }
            const candidateInfo = getCandidateSummary(message.candidate);
            this.#emitDiagnostic("remote-ice-received", candidateInfo);
            if (connection.remoteDescription) {
                await this.#runRtcOperation("addIceCandidate", () =>
                    connection.addIceCandidate(message.candidate), candidateInfo);
                this.#emitDiagnostic("remote-ice-added", { ...candidateInfo, result: "success" });
            } else {
                this.#queuedIceCandidates.push(message.candidate);
                this.#emitDiagnostic("remote-ice-queued", {
                    ...candidateInfo,
                    queueLength: this.#queuedIceCandidates.length
                });
            }
            return;
        }

        throw new Error("Неизвестный тип WebRTC-сигнала");
    }

    async #createPeerConnection(match) {
        this.#resetPeerConnection();
        this.#pendingMatch = match;
        this.#setState("connecting");

        if (!("RTCPeerConnection" in globalThis)) {
            throw new Error("Этот браузер не поддерживает RTCPeerConnection");
        }

        const connection = new RTCPeerConnection(this.#rtcConfiguration);
        this.#peerConnection = connection;
        this.#peerStartedAt = performance.now();
        this.#emitDiagnostic("peerconnection-created", { states: this.#readConnectionStates(connection) });
        this.#startStatsPolling(connection);
        const logState = state => this.#emitDiagnostic("rtc-state-change", {
            state,
            states: this.#readConnectionStates(connection)
        });
        connection.onsignalingstatechange = () => logState("signalingState");
        connection.onicegatheringstatechange = () => logState("iceGatheringState");
        connection.oniceconnectionstatechange = () => {
            logState("iceConnectionState");
            if (connection.iceConnectionState === "failed") this.#failPair("ICE connection failed", "ice-failed");
        };
        connection.onconnectionstatechange = () => {
            logState("connectionState");
            if (this.#peerConnection !== connection) return;
            this.#emit("peerconnectionstate", { state: connection.connectionState });
            if (connection.connectionState === "failed") {
                this.#failPair("PeerConnection failed", connection.iceConnectionState === "failed" ? "ice-failed" : "peerconnection-failed");
            } else if (connection.connectionState === "closed" && this.#state !== "idle") {
                this.#failPair("PeerConnection closed", "peerconnection-closed");
            }
        };
        connection.onicecandidate = event => {
            if (this.#peerConnection !== connection) return;
            if (!event.candidate) {
                this.#emitDiagnostic("local-ice-gathering-complete");
                return;
            }
            const candidateInfo = getCandidateSummary(event.candidate);
            this.#emitDiagnostic("local-ice-candidate", { direction: "local", ...candidateInfo });
            try {
                this.#sendSignal(match.matchId, "ice", event.candidate);
            } catch (error) {
                this.#emitDiagnostic("local-ice-worker-send-error", {
                    ...candidateInfo,
                    message: sanitizeDiagnosticText(error?.message ?? error)
                });
            }
        };
        connection.onicecandidateerror = event => this.#emitDiagnostic("ice-candidate-error", {
            errorCode: event.errorCode ?? null,
            errorText: sanitizeDiagnosticText(event.errorText ?? ""),
            urlScheme: event.url ? event.url.split(":", 1)[0] : null,
            hostCandidate: Boolean(event.hostCandidate)
        });


        if (match.initiator) {
            this.#attachDataChannel(connection.createDataChannel("prototype-messages", {
                ordered: true
            }));
        } else {
            connection.ondatachannel = event => this.#attachDataChannel(event.channel);
        }

        this.#connectionTimeout = setTimeout(() => {
            this.#failPair("WebRTC connection timed out", "timeout");
        }, this.#connectionTimeoutMs);

        if (match.initiator) {
            const offer = await this.#runRtcOperation("createOffer", () => connection.createOffer());
            await this.#runRtcOperation("setLocalDescription(offer)", () =>
                connection.setLocalDescription(offer));
            this.#sendSignal(match.matchId, "offer", connection.localDescription);
            this.#emit("signal", { signalType: "offer-sent" });
        }
    }

    #attachDataChannel(channel) {
        this.#dataChannel = channel;
        this.#lastWorkingSnapshot = null;
        this.#emitDiagnostic("datachannel-attached", { readyState: channel.readyState });
        if (this.#peerConnection) this.#startStatsPolling(this.#peerConnection, channel);
        channel.onopen = () => {
            if (this.#dataChannel !== channel) return;
            this.#emitDiagnostic("datachannel-state-change", { readyState: channel.readyState });
            this.#clearConnectionTimeout();
            this.#setState("connected");
            this.#emit("datachannelopen", {
                match: this.match,
                clientId: this.#clientId,
                peerId: this.#peerId,
                initiator: this.#pendingMatch?.initiator ?? false
            });
        };
        channel.onclose = () => {
            this.#emitDiagnostic("datachannel-state-change", { readyState: channel.readyState });
            if (this.#dataChannel !== channel || this.#state === "idle") return;
            this.#failPair("WebRTC DataChannel closed", "datachannel-closed");
        };
        channel.onerror = () => {
            if (this.#dataChannel !== channel) return;
            this.#failPair("WebRTC DataChannel error", "datachannel-error");
        };
        channel.onmessage = event => {
            if (this.#dataChannel !== channel) return;
            this.#emit("message", { data: event.data });
        };
    }

    #failPair(message, reason = "signaling-error") {
        if (this.#state === "idle") return;
        const error = message instanceof Error ? message : new Error(String(message));
        return this.#terminate({ reason, message: error.message, event: "failure", notifyWorker: true });
    }
}
