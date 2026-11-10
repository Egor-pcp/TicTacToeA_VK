import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    canPlayOnlinePractice,
    createOnlinePracticeState,
    transitionOnlinePracticeState
} from "../../online-session-state.js";

describe("Онлайн-практика и сетевой поиск — независимые состояния", () => {
    test("ошибка авторизации/сервера не закрывает уже разрешённую практику", () => {
        let state = transitionOnlinePracticeState(createOnlinePracticeState(), "search-started");
        assert.equal(canPlayOnlinePractice(state), true);

        state = transitionOnlinePracticeState(state, "search-failed");
        assert.equal(canPlayOnlinePractice(state), true);
    });

    test("победа, ничья и повтор практики не отменяют поиск", () => {
        let state = transitionOnlinePracticeState(createOnlinePracticeState(), "search-started");
        state = transitionOnlinePracticeState(state, "practice-finished");
        assert.equal(canPlayOnlinePractice(state), true);

        state = transitionOnlinePracticeState(state, "practice-restarted");
        assert.equal(canPlayOnlinePractice(state), true);
    });

    test("найденный соперник завершает практику до серверного матча", () => {
        let state = transitionOnlinePracticeState(createOnlinePracticeState(), "search-started");
        state = transitionOnlinePracticeState(state, "match-found");
        assert.equal(canPlayOnlinePractice(state), false);
    });

    test("отмена поиска завершает доступ к практике этого поиска", () => {
        let state = transitionOnlinePracticeState(createOnlinePracticeState(), "search-started");
        state = transitionOnlinePracticeState(state, "search-cancelled");
        assert.equal(canPlayOnlinePractice(state), false);
    });
});
