-- Миграция 0001: Начальная схема базы данных Cloudflare D1

-- Таблица пользователей VK (проверенные профили)
CREATE TABLE IF NOT EXISTS users (
    vk_user_id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);

-- Таблица глобального лидерборда
CREATE TABLE IF NOT EXISTS leaderboards (
    vk_user_id TEXT PRIMARY KEY,
    rating INTEGER DEFAULT 1000,
    games_played INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    best_win_time_ms INTEGER,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (vk_user_id) REFERENCES users(vk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_leaderboards_rating ON leaderboards(rating DESC);

-- История завершённых онлайн-матчей
CREATE TABLE IF NOT EXISTS match_history (
    match_id TEXT PRIMARY KEY,
    board_size INTEGER NOT NULL,
    player_x_id TEXT NOT NULL,
    player_o_id TEXT NOT NULL,
    winner_id TEXT, -- NULL при ничьей
    win_reason TEXT NOT NULL, -- 'win', 'draw', 'timeout', 'abandoned'
    moves_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    FOREIGN KEY (player_x_id) REFERENCES users(vk_user_id),
    FOREIGN KEY (player_o_id) REFERENCES users(vk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_match_history_users ON match_history(player_x_id, player_o_id);
