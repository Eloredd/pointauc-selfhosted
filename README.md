# Pointauc (self-hosted) — аукцион для стрима

Тот же самый фронтенд Pointauc (официальный репозиторий `Pointauc/pointauc_frontend`), к которому
прилагается мини-бэкенд, реализующий нужную часть закрытого Pointauc API. Нужен, когда сайт
pointauc.com лежит, а аукцион провести надо.

## Что работает

| Функция | Статус | Как включить |
|---|---|---|
| Вход через Twitch (реальный) | ✅ | своё Twitch-приложение (5 минут, бесплатно) — см. ниже |
| Аукцион за баллы канала Twitch | ✅ | баллы списываются через custom rewards, рефанды аутсайдерам работают |
| DonationAlerts | ✅ | своё DA-приложение (5 минут, бесплатно) |
| DonatePay (RU и EU) | ✅ | просто вставить API-токен в настройках интеграции, бэкенд не нужен |
| Ставки из чата командой `!bid` | ✅ | работает всегда, можно как запасной вариант |
| Рулетка (колесо) для выбора победителя | ✅ | страница Wheel, крутится по учасникам аукциона |
| Оверлеи для OBS | ⚠️ бета | работает основная страница аукциона, оверлей можно не использовать |
| Прочие сервисы (Kick, VK, IHAQ и т.д.) | ❌ | заглушки |

Лоты аукциона хранятся локально в браузере стримера (как в оригинальном Pointauc),
ставки приходят в реальном времени через WebSocket.

---

## Деплой на Render (бесплатно), ~15 минут

Фронтенд уже собран и лежит в `server/public` — ничего собирать на хостинге не нужно.

### Шаг 1. Залить код на GitHub

```bash
# внутри папки pointauc-selfhosted
git init
git add -A
git commit -m "pointauc self-hosted"
# создайте пустой репозиторий на github.com (например, pointauc-selfhosted), затем:
git remote add origin https://<ВАШ_ТОКЕН>@github.com/<ВАШ_НИК>/pointauc-selfhosted.git
git push -u origin master
```

Токен: github.com → Settings → Developer settings → Personal access tokens → Fine-grained →
Generate (права на Contents: Read and write для этого репозитория).

### Шаг 2. Создать сервис на Render

1. Зарегистрируйтесь на [render.com](https://render.com) (бесплатно, карта не обязательна).
2. **New +** → **Web Service** → **Build and deploy from a Git repository** → подключите GitHub → выберите репозиторий.
3. Настройки:
   - **Runtime**: Node
   - **Build Command**: `cd server && npm install --omit=dev`
   - **Start Command**: `node server/server.mjs`
   - **Instance Type**: Free
4. Нажмите **Deploy Web Service**. Через пару минут сайт будет жить на
   `https://<имя-сервиса>.onrender.com` — это и есть «настоящий сайт» с HTTPS.

Пока не настроены Twitch/DA приложения, уже можно проверить работоспособность:
откройте `https://<имя-сервиса>.onrender.com/twitch/redirect?code=guest` — это гостевой вход
(логин «streamer» без Twitch). Аукцион, чат-ставки `!bid` и DonatePay при этом работают.

### Шаг 3. Twitch-приложение (для реального логина и баллов канала)

1. [dev.twitch.tv/console](https://dev.twitch.tv/console) → вход под аккаунтом стримерши → **Register Your App**.
   - Name: любое уникальное (например, `pointauc-<ник>`)
   - OAuth Redirect URLs: `https://<имя-сервиса>.onrender.com/twitch/redirect`
   - Category: Chat Bot
2. **Manage** → скопируйте **Client ID**; **New Secret** → скопируйте **Client Secret**.
3. В Render: сервис → **Environment** → добавьте переменные:
   - `TWITCH_CLIENT_ID` = Client ID
   - `TWITCH_CLIENT_SECRET` = Client Secret
4. **Save** — сервис перезапустится. Теперь на сайте вход через Twitch работает по-настоящему.

> Клиент ID подхватывается на лету из переменных окружения — пересборка фронта не нужна.

Баллы канала: на странице аукциона нажмите **Listen for channel points**. Бэкенд сам создаст
Twitch-награду (custom reward) на каждый лот с ценой = текущая ставка. Зритель активирует
награду в канале → ставка на лот. Если его перебили — баллы возвращаются (reward отменяется),
победителю — награда выполняется (баллы списываются).

### Шаг 4. DonationAlerts

1. [donationalerts.com](https://www.donationalerts.com) → профиль стримерши →
   **Applications** → **Create application** (или /settings/apps):
   - Redirect URI: `https://<имя-сервиса>.onrender.com/da/redirect`
   - Scopes: `oauth-donation-subscribe oauth-user-show`
2. Скопируйте **Client ID** и **Client Secret**.
3. В Render → Environment → `DA_CLIENT_ID` и `DA_CLIENT_SECRET` → Save.
4. На сайте в панели Integrations нажмите кнопку DonationAlerts → войдите.

Донаты DA появляются как ставки в реальном времени. Сообщение доната — это имя лота:
не найден существующий лот → создаётся новый (так зрители «заявляются» в рулетку).

### Шаг 5. DonatePay

Ничего настраивать на бэкенде не нужно: на сайте → Integrations → DonatePay →
выберите регион и вставьте API-токен со страницы `donatepay.ru/page/api`.

---

## Сценарий аукциона для стримерши

1. Открыть сайт, войти через Twitch.
2. Добавить лоты (призы) — или пусть создаются из донатов автоматически.
3. Integrations → подключить Twitch (баллы канала), DonationAlerts и/или DonatePay.
4. Зрители голосуют деньгами/баллами в течение аукциона; суммы растут в реальном времени.
5. В конце: страница **Wheel** → participants подтягиваются из лотов (вес = сумма взноса) → **Spin**.
6. Победитель объявлен, донат-награды закрываются.

## Ограничения бесплатного Render

- **Засыпание**: без трафика 15 минут сервис «засыпает», первое открытие занимает ~40–60 секунд.
  Во время стрима вкладка с сайтом открыта — значит, сервис активен. Для подстраховки можно
  повесить бесплатный пингер (cron-job.org / UptimeRobot) на раз в 10 минут.
- **Эфемерный диск**: при перезапуске сервиса слетают сессии (просто залогиниться заново)
  и настройки оверлеев. Лоты живут в браузере стримера и не теряются.
- Чат-ставки: слушается канал стримера; команда и канал настраиваются переменными
  `CHAT_BID_COMMAND` (по умолчанию `!bid`) и `CHAT_CHANNEL`.

## Локальный запуск

```bash
cd server
npm install
npm start          # http://localhost:8000, фронтенд берётся из server/public
```

Переменные окружения: `PORT`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `DA_CLIENT_ID`,
`DA_CLIENT_SECRET`, `CHAT_BID_COMMAND`, `CHAT_CHANNEL`, `REWARD_PREFIX`, `FRONTEND_DIST`,
`REQUEST_LOG` (лог запросов).

---

**Лицензия**: код фронтенда — Pointauc (PolyForm Noncommercial 1.0.0, source-available).
Используйте некоммерчески; сохраняйте NOTICE-файл. Бэкенд в этом репозитории написан с нуля
и реализует только публичный контракт API.

## Изменения в фронтенде

Фронтенд — официальный исходники `Pointauc/pointauc_frontend`. Отличия минимальные
(см. `frontend.patch`): client_id Twitch и DonationAlerts теперь подхватываются из
runtime-конфига (`window.__POINTAUC_CONFIG__`, который прокидывает сервер) или из
env-переменных `VITE_TWITCH_CLIENT_ID` / `VITE_DA_CLIENT_ID` — чтобы можно было
использовать свои приложения без пересборки.
