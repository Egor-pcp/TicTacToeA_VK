# Серверная инфраструктура TicTacToeA_VK

Бэкенд онлайн-мультиплеера на базе **Cloudflare Workers**, **Durable Objects** и **Cloudflare D1** для игры «Крестики-нолики» (VK Mini Apps).

---

## 1. Структура сервера

```text
server/
├── src/
│   ├── worker.js           # Точка входа: роутинг HTTP (/api/auth, /api/leaderboard) и WebSocket (/ws)
│   ├── vk-auth.js          # Валидация подписи параметров запуска VK (HMAC-SHA256 на Web Crypto API)
│   ├── token.js            # Выпуск и проверка короткоживущих сессионных токенов (HMAC-SHA256)
│   ├── game-rules.js       # Чистая серверная логика правил (доски 3x3, 4x4, 5x5, проверка побед и ничьих)
│   ├── matchmaker.js       # Matchmaker DO: очередь случайного подбора игроков (FIFO, отмена, жребий 50/50)
│   └── match.js            # Match DO: авторитетная комната матча (валидация ходов, таймеры, reconnect, D1)
├── migrations/
│   └── 0001_initial.sql    # Схема таблиц Cloudflare D1 (users, match_history, leaderboards)
├── test/
│   ├── vk-auth.test.js     # Unit-тесты проверки подписи параметров запуска VK
│   ├── token.test.js       # Unit-тесты выпуска и проверки игровых токенов
│   ├── game-rules.test.js  # Unit-тесты серверных правил и линий победы
│   ├── worker.test.js      # Интеграционные тесты эндпоинтов Worker (Dev-auth, VK-auth, CORS, WS)
│   └── multiplayer.test.js # Интеграционные тесты мультиплеера (15 сценариев очереди, матчей, reconnect, D1)
├── .dev.vars.example       # Пример локальных переменных окружения для Wrangler
├── wrangler.jsonc          # Конфигурация воркера, D1 и Durable Objects
├── package.json            # NPM скрипты
└── README.md               # Документация сервера
```

---

## 2. Локальный запуск сервера

### Требования
- Node.js >= 22 (рекомендуется v26+)
- npm

### Шаги запуска

1. **Установка зависимостей (в каталоге server):**
   ```bash
   cd server
   # В проекте используются нативные Web API; wrangler установлен в webrtc-prototype или глобально
   npx wrangler dev
   ```

2. **Настройка переменных окружения:**
   Скопируйте пример файла конфигурации:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   В файле `.dev.vars` по умолчанию включен режим `DEV_MODE=true`, позволяющий проводить локальное тестирование без подключения к кабинету VK Developers.

3. **Запуск автоматических тестов:**
   ```bash
   npm test
   # или напрямую:
   node --test test/*.test.js
   ```

---

## 3. Как открыть два тестовых клиента (Development Mode)

В режиме разработки (`DEV_MODE=true`) бэкенд поддерживает мгновенную тестовую авторизацию для двух независимых искусственных пользователей:
- `dev_user_1` (Игрок 1)
- `dev_user_2` (Игрок 2)

### Запрос токена игрока 1:
```bash
curl -X POST http://localhost:8787/api/auth \
  -H "Content-Type: application/json" \
  -d '{"devUser": "dev_user_1"}'
```
Ответ:
```json
{
  "token": "<session_token_1>",
  "userId": "dev_user_1",
  "dev": true,
  "expiresIn": 3600
}
```

### Запрос токена игрока 2:
```bash
curl -X POST http://localhost:8787/api/auth \
  -H "Content-Type: application/json" \
  -d '{"devUser": "dev_user_2"}'
```
Ответ:
```json
{
  "token": "<session_token_2>",
  "userId": "dev_user_2",
  "dev": true,
  "expiresIn": 3600
}
```

### Подключение к WebSocket и игра:
1. Игрок 1 подключается к очереди: `ws://localhost:8787/ws?token=<session_token_1>`
2. Игрок 2 подключается к очереди: `ws://localhost:8787/ws?token=<session_token_2>`
3. Оба отправляют команду поиска матча:
   ```json
   {"type": "find_match", "boardSize": 3, "profile": {"name": "Игрок 1"}}
   ```
4. Matchmaker DO находит пару, бросает жребий 50/50 X/O и отправляет обоим:
   ```json
   {"type": "match_start", "matchId": "<uuid>", "role": "X", "boardSize": 3, "turn": "X", "turnDeadlineMs": 30000, "opponent": {...}}
   ```
5. Игроки переподключаются к комнате матча:
   `ws://localhost:8787/ws?token=<session_token>&matchId=<uuid>`
6. Игрок X делает ход:
   ```json
   {"type": "make_move", "index": 4, "seq": 1}
   ```
7. Сервер валидирует ход и транслирует обновлённое состояние (`move_applied` или `match_ended`).
