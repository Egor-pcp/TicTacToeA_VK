function getSameOriginSignalingUrl() {
    if (typeof location === "undefined") {
        return "ws://127.0.0.1:8787/ws";
    }

    const url = new URL("/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
}

const suppliedConfig = globalThis.TICTACTOE_ONLINE_CONFIG ?? {};

export const ONLINE_CONFIG = Object.freeze({
    signalingUrl: suppliedConfig.signalingUrl ?? getSameOriginSignalingUrl(),
    rtcConfiguration: suppliedConfig.rtcConfiguration ?? {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    },
    connectionTimeoutMs: suppliedConfig.connectionTimeoutMs ?? 35_000,
    heartbeatIntervalMs: suppliedConfig.heartbeatIntervalMs ?? 15_000
});
