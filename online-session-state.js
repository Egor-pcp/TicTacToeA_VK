"use strict";

export function createOnlinePracticeState() {
    return { available: false };
}

export function transitionOnlinePracticeState(currentState, event) {
    const available = currentState?.available === true;

    switch (event) {
        case "search-started":
            return { available: true };
        case "search-failed":
        case "practice-finished":
        case "practice-restarted":
            return { available };
        case "match-found":
        case "search-cancelled":
            return { available: false };
        default:
            return { available };
    }
}

export function canPlayOnlinePractice(state) {
    return state?.available === true;
}
