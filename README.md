# Bybit Combo Bot — Grid + DCA + Meta-signals

Торговый бот для спот-рынка Bybit, комбинирующий три стратегии: сеточную торговлю (Grid), усреднение позиции (DCA) с фильтром по RSI, и мета-сигналы на основе технических индикаторов. Все ордера отслеживаются через систему позиций с автоматическим стоп-лоссом, тейк-профитом и trailing stop-loss.

## Стек

- **TypeScript** + ts-node
- **CCXT** — Bybit V5 API (spot)
- **Winston** — логирование (файл + консоль)
- **dotenv** — конфигурация API ключей
- **Telegram Bot API** — уведомления (native https, без зависимостей)

## Структура проекта

```
bybit-combo-bot/
├── .env.example              # Шаблон для API ключей
├── .env                      # API ключи (не коммитится)
├── .gitignore
├── package.json
├── tsconfig.json
├── config.jsonc              # Все параметры бота (hot-reload без перезапуска)
├── README.md
├── CLAUDE.md
├── bot-state.json            # Состояние бота (создаётся автоматически)
├── analyze-volatility.ts     # Скрипт анализа волатильности (standalone CLI)
├── bot.log                   # Лог работы (создаётся автоматически)
├── errors.log                # Только ошибки
├── scripts/
│   ├── check-bybit.ts        # Диагностика: балансы, ордера, тикеры, последние сделки
│   ├── register-commands.ts  # Одноразовая регистрация меню команд в Telegram
│   ├── reset-grid.ts         # Сброс сетки ордеров (standalone, для ручного запуска)
│   └── restart-bot.ts        # Перезапуск бота (kill + start)
└── src/
    ├── index.ts              # Точка входа, main loop, graceful shutdown
    ├── config.ts             # Все настройки бота + валидация
    ├── types.ts              # TypeScript типы и интерфейсы
    ├── exchange.ts           # Обёртка Bybit V5 API через ccxt (retry, precision)
    ├── indicators.ts         # RSI, EMA, Bollinger Bands (чистая математика)
    ├── logger.ts             # Winston: bot.log (10MB x5), errors.log (5MB x3), console
    ├── state.ts              # Персистентное состояние (JSON, debounced atomic write)
    ├── sync.ts               # Синхронизация с биржей при старте + каждые 6ч
    ├── telegram.ts           # Telegram уведомления (queue, rate-limit, HTML)
    ├── volatility.ts         # Общий модуль анализа волатильности (ATR, percentiles, weighted spacing)
    └── strategies/
        ├── grid.ts           # Grid-стратегия (сетка лимитных ордеров + counter-orders)
        ├── dca.ts            # DCA-стратегия с RSI-фильтром (отключена)
        └── combo-manager.ts  # Оркестратор — стратегии, SL/TP/TSL, cooldown, market panic
```

## Текущая конфигурация

| Параметр | Значение | Описание |
|---|---|---|
| **Пары** | DOT 17%, NEAR 17%, ADA 16%, SUI 17%, SOL 17%, XRP 16% | 6 пар, суммарная аллокация 100% |
| **Режим** | USE_TESTNET=false | Mainnet Bybit |
| **Капитал** | ~$307 USDT | На реальном Bybit |
| **Tick интервал** | 10 сек | Проверка рынка каждые 10 секунд |
| **Sync интервал** | 6 часов | Полная синхронизация с Bybit |

### Grid

| Параметр | Значение |
|---|---|
| gridLevels | 6 (3 buy + 3 sell) |
| gridSpacingPercent | per-pair (fallback 1.0%) |
| gridSpacingSellPercent | per-pair (fallback 1.4%) |
| autoSpacingPriority | "auto" (статистика применяется) |
| autoSpacingIntervalMin | 360 (каждые 6ч) |
| autoSpacingSafetyMarginPercent | 10% |
| orderSizePercent | 15% от аллокации пары |
| rebalancePercent | 2% (вверх или вниз от центра) |
| rsiOverboughtThreshold | 70 (100 = отключить) |
| useEmaFilter | false (отключён) |
| useBollingerAdaptive | true |
| bollingerBuyMultiplier | 1.5x (у нижней BB) |
| bollingerSellMultiplier | 1.5x (у верхней BB + bearish EMA) |
| bollingerShiftLevels | 2 |

### Risk Management

| Параметр | Значение |
|---|---|
| stopLossPercent | 10% |
| takeProfitPercent | 12% |
| trailingSLPercent | 5% (trailing) |
| trailingSLActivationPercent | 3% (активация trailing) |
| maxDrawdownPercent | 15% |
| portfolioTakeProfitPercent | 100% |
| cooldownAfterSLSec | 1800 (30 минут) |
| cooldownMaxSL | 3 (3 SL подряд = halt) |

### Market Protection

| Параметр | Значение |
|---|---|
| panicBearishPairsThreshold | 999 (сколько пар вают должно зафиксировать bearish, при 999 - отключено) |
| btcWatchdogEnabled | true |
| btcDropThresholdPercent | 3% за час |
| btcCheckIntervalSec | 300 (5 мин) |

### DCA (отключена)

| Параметр | Значение |
|---|---|
| enabled | false |
| intervalSec | 10800 (3 часа) |
| baseOrderPercent | 5% |
| rsiBoostThreshold | 28 (покупаем 1.7x) |
| rsiSkipThreshold | 70 |

### Telegram-уведомления

| Параметр | Значение |
|---|---|
| enabled | auto (при наличии token + chatId) |
| sendSummary | true (раз в 60 тиков ≈ 10 мин) |
| sendFills | true (уведомления об исполненных сделках) |
| sendAlerts | true (SL/TP/halt/panic/cooldown) |
| commandPollIntervalTicks | 3 (проверка команд каждые 3 тика) |

Бот отправляет в Telegram:
- Стартовое сообщение (режим, пары)
- Summary портфеля каждые ~10 минут
- Fill-уведомления при исполнении grid-ордеров
- Алерты: Stop-Loss, Trailing SL, Take-Profit, Max Drawdown, Portfolio TP

### Состояния пар

Каждая пара в `config.jsonc` может иметь поле `state`. Состояние синхронизируется между конфигом и Telegram-командами (hot-reload ~30с).

| Состояние | Маркер | Описание |
|---|---|---|
| `unfreeze` | _(нет)_ | Обычный режим. Grid + DCA + мета-сигналы работают в полную силу. Это состояние по умолчанию. |
| `freezebuy` | 🧊 | Покупки заморожены. Все buy-ордера отменяются, новые не ставятся. Sell-ордера работают в обычном режиме. SL/TP/TSL активны. Используется когда нужно распродать позицию без новых докупок. |
| `sellgrid` | 🔻 | Режим лестничной распродажи. После каждого sell fill ставится новый sell выше (вместо counter-buy) — позиция плавно распродаётся вверх. Авто-включает freezebuy. Когда позиция исчерпана (< minAmount) — пара автоматически переводится в freezebuy. |
| `freeze` | 🧊❄️ | Полная заморозка. Grid/DCA/мета-сигналы не работают, сетка не строится. **Только SL/TP/TSL продолжают защищать позицию.** Все ордера (buy и sell) отменяются при включении. Используется для временной полной остановки торговли по паре без потери позиции. |
| `deleted` | _(скрыт)_ | Пара удалена из торговли. Скрыта из `/status`, `/stats`, BOT SUMMARY. Не учитывается в аллокациях. Позиция и история сохраняются в `bot-state.json`. При режиме `allocationPercentMode: "auto"` — оставшиеся пары автоматически получают пересчитанные доли. |

**Авто-переводы:**
- Пара автоматически переходит в `freezebuy` если в режиме `sellgrid` остаток позиции упал ниже `dustThresholdUSDT` (пыль) — покупки блокируются, но существующие sell-ордера продолжают исполняться.
- `/sellgrid` авто-включает freezebuy.
- `/unsellgrid` авто-разблокирует покупки (переходит в `unfreeze`).

### Telegram-команды

Управление ботом через Telegram (команды обрабатываются даже когда бот остановлен):

| Команда | Описание |
|---|---|
| `/start` | Приветствие + список всех команд по группам |
| `/status` | Сводка: капитал, PnL, позиции по всем парам (с маркерами 🧊/🔻/🧊❄️) |
| `/stats` | Статистика по парам (sorted by PnL desc) + цена + дистанция до nearest buy/sell |
| `/orders` | Показать все открытые ордера |
| `/buy` | Wizard покупки (без args — кнопки валют + сумм). Работает даже на замороженной паре. |
| `/buy SUI 10` | Купить 10 токенов SUI за USDT (market order, без проверки состояния пары) |
| `/buy SUI BTC 10` | Купить 10 токенов SUI за BTC (market order) |
| `/sellall` | Продать все позиции + отменить ордера + halt |
| `/cancelorders` | Отменить все ордера + сбросить grid + halt |
| `/regrid` | Сброс сетки (cancel orders) + перестройка с текущим spacing. Sell-ордера с counter-sell metadata (`oldBreakEven`, `originalPlannedSellPrice`) сохраняются — trailing продолжает работать после перестройки. |
| `/stop` | Остановить торговлю (halted=true) |
| `/run` | Возобновить торговлю (сбрасывает halt, cooldown, consecutiveSL) |
| `/freezebuy` | Заморозить покупки по валюте (wizard или `/freezebuy XRP`). Маркер 🧊 |
| `/unfreezebuy` | Разморозить покупки + force-rebalance |
| `/sellgrid` | Sellgrid-режим: после sell fill ставить новый sell выше (ladder). Авто-freeze. Маркер 🔻 |
| `/unsellgrid` | Отключить sellgrid + разморозить buy (→ `unfreeze`) |
| `/freeze` | Полная заморозка пары: отменить все ордера (buy и sell), прекратить grid/DCA/meta. SL/TP/TSL продолжают работать. Маркер 🧊❄️ |
| `/unfreeze` | Полная разморозка пары (grid/DCA/meta возобновляются) + force-rebalance |
| `/addtoken` | Добавить новую валюту в торговлю (wizard с вводом тикера и аллокации) |
| `/removetoken` | Удалить валюту из торговли (переводит в `deleted`, при `auto` режиме пересчитывает аллокации) |

**Два вида PnL:**
- `/stats` — **Realized PnL** (per-pair): только закрытые сделки (`earned − spent − fees`). Может показывать большой минус если крипта куплена, но ещё не продана — это нормально, позиция удерживается
- `/stats` TOTAL — **Portfolio PnL**: `текущий капитал − стартовый капитал`. Реальное изменение богатства: USDT free + текущая рыночная стоимость всех позиций. Совпадает с `/status` PnL

Ручные покупки через `/buy` не входящих в конфиг пар отслеживаются отдельно (`manualPairs`), отображаются в `/status` и `/orders`, продаются по `/sellall`.

**Меню команд** регистрируется автоматически при каждом запуске бота через `setMyCommands` API.

### Поведение `/freeze` и `/buy` на замороженной паре

**`/freeze XRP` делает:**
1. Отменяет **все** открытые ордера по паре (и buy, и sell)
2. Добавляет пару в `frozenPairs` + `blockedBuyBases` (переживает рестарт)
3. В `processPair` — ранний выход: grid, DCA, мета-сигналы не запускаются
4. SL/TP/TSL **продолжают работать** (проверяются до freeze-check)
5. Записывает `state: "freeze"` в `config.jsonc`

**`/buy XRP 10` на замороженной паре:**
- **Выполнится** — `cmdBuy` не проверяет состояние пары (`isPairFrozen` / `isBlockedBuy`)
- Выставляет рыночный ордер, обновляет позицию в `bot-state.json`
- Новые grid-ордера автоматически **не** выставятся — пара остаётся frozen
- Чтобы бот снова начал торговать по паре — нужен `/unfreeze XRP`

> Таким образом, `/freeze` + `/buy` — это способ докупить вручную без автоматической торговли. `/unfreeze` после этого запустит force-rebalance и выстроит новую сетку вокруг текущей цены.

### Telegram через прокси (Custom API URL)

Если `api.telegram.org` недоступен или нестабилен, бот поддерживает custom API endpoint через параметр `telegramApiUrl` в `config.jsonc`:

```jsonc
"telegram": {
  "telegramApiUrl": "https://your-worker.your-name.workers.dev",
  // ...остальные параметры
}
```

При пустом значении или отсутствии параметра используется стандартный `api.telegram.org`.

**Бесплатный relay через Cloudflare Worker (рекомендуется):**

1. Зарегистрироваться на [Cloudflare Workers](https://workers.cloudflare.com/) (бесплатно)
2. Создать новый Worker → вставить код:

```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'api.telegram.org';
    url.port = '';
    url.protocol = 'https:';
    const newRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return fetch(newRequest);
  },
};
```

3. Deploy → скопировать URL воркера (вида `https://tg-relay.username.workers.dev`)
4. Вписать URL в `config.jsonc` → `telegram.telegramApiUrl`

**Пошагово (5 минут):**

1. Открыть https://workers.cloudflare.com/
2. Нажать **Sign Up** → регистрация через email (бесплатно, карта не нужна)
3. В Dashboard нажать **Workers & Pages** → **Create** → **Create Worker**
4. Дать имя (например `tg-relay`) → нажать **Deploy**
5. Нажать **Edit Code** → стереть всё → вставить код выше → нажать **Deploy**
6. Скопировать URL вида `https://tg-relay.username.workers.dev`

**Лимиты бесплатного тарифа Cloudflare Workers:** 100,000 запросов/день. Боту нужно ~200-500 запросов/день — хватает с огромным запасом.

**Также поддерживается HTTP/SOCKS5 прокси** через параметр `proxyUrl`:

```jsonc
"telegram": {
  "proxyUrl": "socks5://host:port",
  // или "proxyUrl": "http://host:port",
}
```

> **Примечание:** MTProxy (`tg://proxy?...`) НЕ совместим с Bot API. MTProxy работает только с клиентами Telegram (мобильные/десктоп приложения) на уровне протокола MTProto. Для Bot API нужен HTTP/SOCKS5 прокси или custom API URL.

## Торговая стратегия

### 1. Grid (сеточная торговля)

Размещает сетку лимитных ордеров на покупку ниже текущей цены и на продажу выше. Buy-уровни с шагом 0.8%, sell-уровни с шагом 1.4% (раздельные spacing). Когда покупка исполняется — бот ставит контр-ордер на продажу на уровень выше (+ gridSpacingSell%). Когда продажа исполняется — ставит контр-ордер на покупку ниже. Зарабатывает на каждом колебании цены внутри диапазона.

**Bollinger Bands Adaptive Grid:** когда цена у нижней полосы BB — больше buy-уровней (shift +2) и увеличенный orderSize (x1.5). Когда у верхней BB + bearish EMA — больше sell-уровней и увеличенный sell size. При bullish EMA sell не усиливается.

**Fallback при нехватке капитала (Bollinger multiplier):**

Если умноженный размер (1.5x) не помещается в свободный баланс — бот **не пропускает** ордер, а выставляет **столько сколько есть**:

- **Buy:** хотим купить на $7.5 (1.5x), есть $5 USDT → считаем сколько монет можем купить на $5 (с учётом minAmount и minCost) → покупаем это количество. Лог: `Buy reduced (low USDT): 0.06 → 0.04 (67% of target)`.
- **Sell:** хотим продать 10 SUI (1.5x), есть 7 SUI → продаём все 7 (если >= minAmount и minCost × price). Лог: `Sell reduced (low SUI): 10 → 7 (70% of target)`.
- **Skip только если** даже минимальный размер (minAmount/minCost) не помещается в баланс.

Это предотвращает "замораживание" торговли когда на 1.5x не хватает — бот всё равно торгует по доступному размеру.

**Фильтры для buy-ордеров:**
- RSI > rsiOverboughtThreshold (70) — grid buy пропускается
- EMA фильтр отключён (useEmaFilter=false)

**Rebalance:** если цена ушла >2% от центра сетки:
- **Drift UP:** полная перестройка (все ордера отменяются, сетка пересоздаётся)
- **Drift DOWN (split rebalance):** только buy-ордера перестраиваются, sell-ы остаются на месте (защита от продажи в убыток)

**Per-pair spacing:** каждая пара может иметь свой `gridSpacingPercent` / `gridSpacingSellPercent` в секции `pairs`. Если не указан — берётся глобальный из секции `grid`.

**Auto-adaptive spacing:** бот автоматически пересчитывает оптимальный spacing на основе статистики волатильности (ATR%, перцентили размаха свечей, взвешенное среднее по 4 периодам и 3 таймфреймам). Управляется параметром `autoSpacingPriority`:
- `"off"` — выключено, не считает, не тратит API
- `"config"` — считает и пишет в лог/Telegram для сравнения, торгует по config-значениям
- `"auto"` — считает и **применяет** к торговле (перекрывает config)

При `"auto"`:
1. При старте бота — запускается анализ (~40 сек), сетки строятся на config-значениях, затем force-rebalance с auto-значениями
2. Каждые `autoSpacingIntervalMin` минут — пересчёт в фоне (fire-and-forget, не блокирует торговлю)
3. `autoSpacingSafetyMarginPercent` — коэффициент недоверия, вычитает N% из расчётных значений (например 10% = spacing * 0.9)
4. Floor: buySpacing >= 0.3%, sellSpacing >= buySpacing + 0.3% (гарантия прибыли после комиссий)
5. Результат логируется и отправляется в Telegram с пометкой `[AUTO]` / `[CFG]`

**Что происходит каждые `autoSpacingIntervalMin` минут:**
1. Запускается `runAutoSpacing()` в фоне (fire-and-forget)
2. Загружает свечи с Bybit (72 API вызова, ~40 сек)
3. Считает новый ATR%, перцентили, weighted spacing
4. Применяет safetyMargin → получает новые buySpacing/sellSpacing
5. Обновляет `autoSpacingMap` в памяти → `grid.setAutoSpacing()`
6. Логирует результат + отправляет в Telegram

**Что НЕ происходит:** сетки не перестраиваются. Новые значения spacing применяются только при:
- Следующем ребалансе (drift >2%)
- Counter-ордерах (fill → встречный ордер)
- Orphan-sell

Существующие ордера на бирже остаются со старым spacing. Новый spacing "просачивается" постепенно через новые ордера.

Принудительный ребаланс (`forceRebalanceAll`) делается только при **первом** расчёте после старта бота.

**No-Loss Sell Protection — 6 механизмов:**

1. **Grid Sell Guard** (`placeGridOrders`): если цена sell-уровня ниже `avgEntryPrice * 1.003` — **поднимает** цену до break-even и выставляет. Если break-even ≤ текущей цены (ордер бы исполнился мгновенно в убыток) — skip.

2. **Counter-Sell Guard** (после buy fill): counter-sell = `buyPrice * (1 + sellSpacing%)`. Если ниже break-even — цена **поднимается** до `avgEntryPrice * 1.003`. Гарантирует прибыль на каждом buy→sell цикле.

3. **Split Rebalance** (`initGrid`): при ребалансе вниз (цена упала >2% от центра) — отменяются **только buy** ордера, sell-ы **остаются на месте** на прибыльных уровнях. Новые buy создаются вокруг новой цены. При ребалансе вверх — полная перестройка (sell-ы уже исполнились).

4. **Counter-Sell Midpoint Trailing** (при split rebalance DOWN): для каждого counter-sell ордера (созданного после buy-fill) хранится `oldBreakEven` и `originalPlannedSellPrice`. При ребалансе DOWN вычисляется `virtualNewSellPrice = currentPrice × (1 + sellSpacing%)`. Шаг 2: если `virtualNewSellPrice < oldBreakEven`, ордер переставляется на `max(oldBreakEven, midpoint(originalPlanned, virtualNew))`, запускается таймер `counterSellTrailStepHours` (4ч). Шаг 3: иначе — сразу на `virtualNewSellPrice`. Шаг 4 (каждый тик по таймеру): `T = midpoint(currentSellPrice, virtualNewSellPrice)` без защиты oldBreakEven. Если `|T - virtualNew| / virtualNew ≤ 5%` → финиш на virtualNew. Иначе → перестановка на T, запуск таймера. Двоичный поиск, ~6-7 шагов до цели. Orphan-sell и initial grid sells — не трейлятся.

5. **Orphan-sell** (непокрытая позиция): `sellPrice = max(avgEntryPrice-based, currentPrice-based)` — всегда выше entry.

6. **SL/TP/Trailing SL** (аварийная продажа): market sell, guard **не применяется**. TSL может продать с мелким убытком (-2%): activation +3% → trailing -5% от пика = нетто -2.15%. Это допустимо — TSL защищает от большего падения.

**Counter-orders:** при fill buy ордера ставится sell counter на цену + spacing%; при fill sell ордера — buy counter на цену - spacing%. Counter-orders проверяют баланс перед размещением.

Grid-ордера — лимитные, исполняются напрямую в `grid.ts`. Combo-manager не дублирует эту логику: grid всегда возвращает `signal='hold'`.

### 2. DCA с RSI-фильтром (отключена)

Периодическая покупка с корректировкой объёма по RSI:
- **RSI < 28** — покупаем 1.7x объёма
- **RSI 28–70** — обычный объём
- **RSI > 70** — пропуск

### 3. Мета-сигналы

Когда несколько индикаторов совпадают — рыночные ордера:
- **STRONG BUY**: RSI < 25 + bullish EMA + below lower BB → 8% от аллокации
- **STRONG SELL**: RSI > 75 + bearish EMA + above upper BB → 8%
- **BUY**: RSI < 35 + below middle BB → 5%
- **SELL**: RSI > 65 + above upper BB → 5%

## Что бот делает каждый тик (10 сек)

1. Проверяет `halted` — если да, ничего не делает
2. Загружает USDT + все крипто-балансы одним вызовом (`fetchBalanceAndAll`)
3. Считает полную стоимость портфеля (USDT + крипта)
4. Обновляет пиковый капитал
5. Проверяет max drawdown — halt если >15%
6. Проверяет portfolio TP — sell everything если +100%
7. Market protection: panic detector + BTC watchdog
8. Для каждой пары:
   - Проверяет cooldown и halt
   - Загружает свечи 5m + тикер параллельно
   - Кеширует market precision
   - Вычисляет RSI(14), EMA(9/21), Bollinger(20,2)
   - Per-position SL/TP/TSL — если сработал, закрывает и cooldown
   - Grid: проверяет fills, ставит counter-orders, replaces unplaced levels
   - DCA + мета-сигналы (если market protection не активна)
   - Выполняет market orders от DCA и meta
9. Каждые 10 тиков — сводка (summary log + Telegram каждые 60 тиков)

## Управление рисками

### Многоуровневая защита

1. **Hard Stop-Loss (10%)** — цена упала на 10% от avg entry → market sell + cooldown
2. **Trailing Stop-Loss (5%, активация +3%)** — после роста >3% от entry включается trailing; если цена падает на 5% от пика → sell. Обычно фиксирует прибыль.
3. **Take-Profit (12%)** — цена выросла на 12% от entry → market sell + reset
4. **Portfolio Take-Profit (100%)** — портфель удвоился → sell everything + halt
5. **Max Drawdown (15%)** — портфель упал на 15% от пика → halt
6. **Cooldown** — после SL пауза 30 минут; 3 SL подряд = halt до ручного вмешательства
7. **Market Panic** — отключён (threshold=999)
8. **BTC Watchdog** — BTC упал на 3%+ за час → пауза всех покупок
9. **RSI + EMA фильтры** — блокируют grid buy при overbought / bearish crossover

### Max Drawdown — подробно

**Где задаётся:** `config.jsonc` → `risk.maxDrawdownPercent` (текущее 15, рекомендуемое 25-30 для grid-бота).

**Формула:**
```
drawdown = (peakCapital − currentPortfolio) / peakCapital × 100
```

- **`peakCapital`** — пиковая стоимость портфеля за всё время работы бота (USDT free + все позиции × текущая рыночная цена). Обновляется каждый тик ([combo-manager.ts:403-405](src/strategies/combo-manager.ts#L403-L405))
- **`currentPortfolio`** — текущая стоимость (то же: USDT + позиции × current price)
- Проверка: если `drawdown > maxDrawdownPercent` → halt ([combo-manager.ts:413](src/strategies/combo-manager.ts#L413))

**Учитываются нереализованные убытки.** Если купил 10 SUI по $1.00, цена упала до $0.80 — позиция уже даёт -20% и это в `currentPortfolio`, даже если не продавал.

**Учёт депозитов/выводов** ([combo-manager.ts:381-391](src/strategies/combo-manager.ts#L381-L391)):
- При депозите извне — `startingCapital` и `peakCapital` увеличиваются на сумму депозита (не триггерит ложный PTP)
- При выводе — оба уменьшаются, `peakCapital` clamp'ится до `max(current, startingCapital)` (не триггерит ложный drawdown)

**Что происходит при триггере:**
1. `state.halted = true` установлен
2. `return` из функции
3. ❌ НЕТ market-продажи позиций (в отличие от SL/TP/sellall)
4. ❌ НЕТ отмены ордеров (в отличие от SL/TP)
5. Telegram-алерт: `🚨 MAX DRAWDOWN X.X%  Peak: $Y → $Z USDT  Bot HALTED!`

**Во время halt:**
- Telegram-команды работают (`/run`, `/status`, `/buy` — обрабатываются до halted-check в [combo-manager.ts:262](src/strategies/combo-manager.ts#L262))
- Ранний выход в [combo-manager.ts:264](src/strategies/combo-manager.ts#L264) — `processPair` не запускается
- Grid.evaluate() не вызывается → **ребаланс не сработает**, fills не обрабатываются, counter-orders не ставятся
- Лимитные ордера на бирже **продолжают жить** — биржа может их исполнить в любой момент (но бот об этом узнает только после `/run` + sync)

**Взаимодействие с `stopLossPercent`:**
- SL per-pair (20% от avgEntry одной пары) → продаёт только эту пару, остальные работают
- maxDrawdown per-portfolio (16% от пика) → halt всего, ничего не продаётся
- Что сработает раньше — зависит от сценария:
  - **Изолированный крах пары** (-25% по одной) → SL сработает первым (вклад в портфель ~3.5%)
  - **Рыночный обвал** (-15% все сразу) → maxDrawdown сработает первым
  - **Комбинированный** — сначала SL по наиболее убыточной, потом может сработать maxDrawdown если убытки продолжаются

**Возобновление:**
- `/run` в Telegram — сбрасывает `halted`, resume без рестарта процесса
- Или вручную: остановить процесс → `halted: false` в `bot-state.json` → запуск
- `peakCapital` **не сбрасывается** при resume — новый отсчёт drawdown пойдёт от того же пика. Пик переопределится только если портфель вырастет выше него.

**Рекомендации по значениям:**

| Цель | `maxDrawdownPercent` | `stopLossPercent` |
|---|---|---|
| Переживать коррекции, накапливать | 25-30% | 18-20% |
| Сбалансированно | 20% | 15% |
| Жёсткая защита капитала | 15% | 10% |

Исторические просадки альткоинов: май 2021 до -80%, LUNA 2022 до -90%, декабрь 2024 до -35%, апрель 2025 до -55%. 15% maxDrawdown = halt при обычной коррекции рынка.

### Stop-Loss — подробно

**Где задаётся:** `config.jsonc` → `risk.stopLossPercent` (текущее 20, рекомендуемое 18-20% для grid-бота). Связанные: `cooldownAfterSLSec` (пауза после SL, default 1800 = 30 мин), `cooldownMaxSL` (макс SL подряд до hard halt, default 3).

**Формула (per-position):**
```
pnlPercent = (currentPrice − avgEntryPrice) / avgEntryPrice × 100
```

- **`avgEntryPrice`** — средняя цена покупки позиции: `positionCostBasis / positionAmount`. Усредняется вниз при grid-накоплении (каждая новая покупка на более низком уровне снижает avg)
- **`currentPrice`** — рыночная цена сейчас (из тикера)
- Проверка: если `pnlPercent ≤ -stopLossPercent` → триггер SL ([combo-manager.ts:769](src/strategies/combo-manager.ts#L769))

**Dust guard** ([combo-manager.ts:753-761](src/strategies/combo-manager.ts#L753-L761)): если стоимость позиции `< minCost` биржи — SL пропускается (чтобы не зациклиться на пыли). Позиция остаётся, orphan-sell подберёт её на прибыльной цене.

**Что происходит при триггере** ([combo-manager.ts:768-783](src/strategies/combo-manager.ts#L768-L783), `closePosition`):
1. Отменяются **все grid-ордера** по паре (`grid.cancelAll(symbol)`)
2. Poll (до 5 попыток × 1 сек) — ждём пока баланс освободится после отмен
3. `sellAmount = min(freeBalance, positionAmount)` — не продаём больше свободного
4. Округление до `amountPrecision` + проверка `minAmount` / `minCost`
5. `createMarketSell(symbol, sellAmount, 'risk', 'stop-loss')` — рыночная продажа
6. `addTrade(...)` + `reducePosition(...)` — фиксация убытка
7. `handlePostSL(...)` — обработка cooldown / halt

**Cooldown / consecutive SL** ([combo-manager.ts:859-897](src/strategies/combo-manager.ts#L859-L897)):
- `consecutiveSL[symbol]` увеличивается на 1
- **Если `consecutiveSL ≥ cooldownMaxSL` (3)**: `haltPair(symbol)` → полная заморозка **только этой пары** навсегда (до `/run`). Остальные пары работают.
- **Иначе если `cooldownAfterSLSec > 0`**: пара ставится в cooldown до `Date.now() + cooldownSec × 1000`. Во время cooldown `processPair` её пропускает.
- **Если `cooldownAfterSLSec = 0`**: haltPair навсегда (старое поведение).
- `consecutiveSL[symbol]` сбрасывается на 0 **только** после профитной продажи (TP или успешный TSL) — несколько SL без профита между ними считаются подряд.

**Trailing Stop-Loss (TSL) — защитная прибыль:**
- Конфиг: `trailingSLPercent` (5% = drop от пика), `trailingSLActivationPercent` (3% = активация после профита)
- Формула: после `pnlPercent ≥ trailingSLActivationPercent` обновляется `trailingPeak[symbol] = max(peak, currentPrice)` каждый тик
- При `(trailingPeak − currentPrice) / trailingPeak × 100 ≥ trailingSLPercent` → market sell (reason='trailing-stop')
- Если TSL продал в прибыль → `resetConsecutiveSL` (цикл не считается SL-неудачей)
- Если TSL продал в убыток (rare: activation +3% → drop -5% = нетто -2%) → `handlePostSL` → cooldown как обычный SL
- **Отключение TSL**: поставить `trailingSLPercent: 999` и `trailingSLActivationPercent: 999` (текущая конфигурация — TSL выключен)

**Разница SL vs maxDrawdown:**

| Параметр | Stop-Loss | Max Drawdown |
|---|---|---|
| Уровень | per-pair (одна позиция) | per-portfolio (весь капитал) |
| База отсчёта | `avgEntryPrice` этой пары | `peakCapital` портфеля |
| Действие | **market sell этой пары** + cooldown | **halt всего**, ничего не продаётся |
| Ордера остальных пар | Работают | Висят на бирже, не обрабатываются |
| Восстановление | Авто через 30 мин (cooldown) | Только ручной `/run` |

**Рекомендации:**

| Цель | `stopLossPercent` |
|---|---|
| Тугая защита капитала | 10-12% |
| Сбалансированно | 15% |
| Grid-friendly (даёт место усреднению) | 18-22% |
| Выключить (продажи только через /sellall или maxDD) | 999 |

Grid стратегия усредняет вниз через buy-уровни — это её механизм работы. Слишком тугой SL (10%) срабатывает на обычных откатах, не давая накоплению развернуться. Слишком широкий (25%+) — позиция становится тяжёлой, restoration требует существенного отскока.

### Процедура закрытия позиции (closePosition)

Общие шаги для SL, TSL, TP, Portfolio-TP:

1. Отменяются все grid-ордера по паре (`grid.cancelAll`)
2. Poll до 5 секунд — ждём освобождения баланса после отмен
3. `Math.min(free, positionAmount)` — не продаём больше доступного
4. Округление до market precision (`Math.floor` + minAmount/minCost check)
5. `createMarketSell(symbol, amount, 'risk', reason)` — рыночная продажа
6. Обновление position + trade record
7. Cooldown или halt в зависимости от consecutiveSL count (только SL и losing TSL)

## Персистентность состояния

`bot-state.json` хранит:
- Позиции (amount + costBasis) для каждой пары
- Grid-уровни с orderId
- DCA-таймеры и статистика
- Пиковый и стартовый капитал
- Trailing peak per pair
- Cooldown timestamps
- Consecutive SL counters
- Halt flags (global + per-pair)
- История последних 100 сделок

Запись debounced (не чаще раза в секунду) и атомарная (write → tmp → rename).

**Ручная коррекция позиций** — если нужно вписать позицию вручную (после сброса state, миграции и т.д.), редактировать `bot-state.json` → `pairs["SUI/USDT"]`:

```json
{
  "positionAmount": 38.72771,
  "positionCostBasis": 36.50
}
```

- `positionAmount` — количество крипты (total, не free)
- `positionCostBasis` — сколько USDT потрачено на покупку (amount × avgEntry)
- `avgEntryPrice` вычисляется на лету: `costBasis / amount`
- **НЕ** использовать `position: { amount, avgEntryPrice }` — такого поля нет, state его проигнорирует
- Бот должен быть остановлен при редактировании (иначе debounced write перезапишет)

### Синхронизация с биржей (sync.ts)

При каждом запуске + каждые 6 часов:
1. Загружает открытые ордера с Bybit
2. Сверяет с grid-уровнями — удаляет ордера, которых нет на бирже
3. Отменяет zombie-ордера (на бирже есть, в state нет)
4. Строит полный snapshot портфеля
5. Логирует состояние

## Точность ордеров (Market Precision)

Загружается через ccxt, кешируется per symbol:
- `pricePrecision` — decimal places для цены
- `amountPrecision` — decimal places для количества
- `minAmount` — минимум для ордера
- `minCost` — минимум в USDT

Bybit использует TICK_SIZE precision mode — бот конвертирует tick size в decimal places автоматически. Суммы округляются вниз (`Math.floor`).

## Lock-файл (bot.lock)

Файл `bot.lock` предотвращает запуск двух экземпляров бота одновременно. Содержит PID процесса.

### Жизненный цикл

| Событие | Что происходит с bot.lock |
|---------|--------------------------|
| **Запуск бота** | Проверяет bot.lock → если PID жив → отказ; если PID мёртв → перезаписывает; если нет файла → создаёт |
| **Soft shutdown** (Ctrl+C × 1) | Удаляет bot.lock → process.exit(0) |
| **Hard shutdown** (Ctrl+C × 2) | Удаляет bot.lock → отменяет все ордера → process.exit(1) |
| **Force exit** (Ctrl+C × 3) | Удаляет bot.lock → process.exit(2) |
| **Fatal error** (crash) | Удаляет bot.lock → process.exit(1) |
| **Telegram /stop** | bot.lock **не удаляется** — процесс жив, просто halted=true. /run возобновит торговлю |
| **Telegram /run** | bot.lock не меняется — процесс тот же |
| **Убит через диспетчер задач** | bot.lock **остаётся**, но при следующем запуске бот проверит PID через `process.kill(pid, 0)` — процесс мёртв → stale lock → перезапишет |
| **taskkill //F //IM node.exe** | bot.lock **остаётся** — аналогично диспетчеру задач, stale lock обрабатывается |
| **scripts/restart-bot.ts** | Удаляет bot.lock перед запуском нового процесса |
| **scripts/reset-grid.ts** | Удаляет bot.lock после сброса сетки |
| **Отключение питания / BSOD** | bot.lock остаётся — stale lock, бот запустится нормально |

### Ручное удаление

Если бот не запускается из-за lock:
```bash
rm bot.lock
# или
del bot.lock
```

### Проверка PID (как работает stale-detection)

```typescript
try {
  process.kill(pid, 0); // signal 0 = проверка без убийства
  // Процесс жив → отказ запуска
} catch {
  // Процесс мёртв → stale lock → перезаписываем
}
```

`process.kill(pid, 0)` кроссплатформенный — работает на Windows, Linux, macOS.

## Запуск

### 1. Установка

```cmd
cd /d D:\project\bbt\bybit-combo-bot
npm install
```

### 2. Настройка API ключей

```cmd
copy .env.example .env
```

Заполнить `.env`:
```
BYBIT_API_KEY=ваш_ключ
BYBIT_API_SECRET=ваш_секрет
USE_TESTNET=true
```

Ключи testnet: https://testnet.bybit.com → API Management
Ключи live: https://www.bybit.com/app/user/api-management

### 3. Запуск

```bash
# Разработка
npm run dev

# Или напрямую
npx ts-node src/index.ts

# Фоновый запуск
npx ts-node src/index.ts > /dev/null 2>&1 &

# Мониторинг
tail -f bot.log
```

### 4. Продакшен

```bash
npm run build
npm start
```

## Остановка

- **`/stop` в Telegram** — остановить торговлю (процесс продолжает работать, ордера на бирже)
- **Ctrl+C** (1 раз) — soft shutdown, grid-ордера остаются на бирже
- **Ctrl+C** (2 раза) — hard shutdown, все ордера отменяются
- **Автоматически** — при SL/TP/drawdown/portfolio TP

### Возобновление после halt

**Вариант 1 — через Telegram (рекомендуется):**

Отправить `/run` в Telegram-чат с ботом. Без перезапуска процесса.

**Вариант 2 — вручную:**

1. Остановить процесс бота
2. В `bot-state.json` поставить `"halted": false`:
   ```json
   {
     "halted": false
   }
   ```
3. Для per-pair halt: в `pairs` → нужная пара → `"halted": false`, `"consecutiveSL": 0`
4. Перезапустить бот

## Логи

- **bot.log** — полный лог (ротация 10MB x 5 файлов)
- **errors.log** — только ошибки (5MB x 3 файла)
- **console** — всё в реальном времени

Summary каждые 10 тиков: капитал, PnL, drawdown, trades, positions, market panic/BTC watchdog.

## Changelog

### v0.7.0 — `1b3b433` (2026-04-13)

Крупное обновление: исправление критических багов, улучшение orphan-sell, skip-логирование, retry.

**Критические фиксы:**
- **closePosition возвращает boolean** — SL/TP/trailing проверяют результат и не сбрасывают позицию при неудачной продаже
- **Trailing SL при убытке → cooldown** — раньше trailing SL при убытке не запускал cooldown, теперь запускает (как обычный SL)
- **Counter-buy без RSI/EMA фильтра** — контр-ордер после sell fill больше не блокируется индикаторами (часть grid-цикла)
- **Counter-sell корректировка суммы** — если fee съел часть баланса, ордер автоматически уменьшается вместо ошибки
- **filledAmount fallback** — fallback на expectedAmount только при status=closed, иначе 0 (предотвращает phantom fills)
- **Обработка 'cancelled' от Bybit** — Bybit возвращает и 'canceled', и 'cancelled', теперь обрабатываются оба варианта

**Orphan-sell покрытие:**
- Старая логика: "есть ли хоть 1 sell ордер?" → Новая: "покрывают ли sell-ордера всю позицию?"
- Непокрытая позиция → несколько sell-ордеров на разных ценовых уровнях (+0.5%, +1.0%...)
- Цена sell = `max(entryBased, priceBased)` — защита от отклонения Bybit по минимальной цене
- Максимум 5 orphan-sell за тик (safety limit)

**Sync (sync.ts):**
- При пропаже ордера из open orders — проверяет через `fetchOrder` был ли он filled
- Filled ордера обновляют позицию и записывают trade
- Fallback на `fetchClosedOrders` если order purged из истории Bybit
- Неизвестные ордера на бирже adoptируются в grid (вместо отмены)

**Skip-логирование:**
- Причины пропуска grid-ордеров выводятся на уровне INFO (было DEBUG)
- Обобщённые причины: `overbought`, `EMA bearish`, `low USDT`, `low SOL` — без конкретных цифр RSI/баланса
- Дедупликация: лог появляется только при изменении причин, молчит между тиками
- `Grid orders resumed` — когда все ордера снова размещены

**Retry и устойчивость:**
- `RateLimitExceeded` добавлен в transient errors для retry
- Exponential backoff: 1s → 2s → 4s (было линейное 1s → 2s)

**Конфигурация:**
- Аллокации: SUI 25%, SOL 40%, XRP 35%
- orderSizePercent: 20% (было 18%)
- rebalancePercent: 2% (было 3%)
- gridLevels: 20 (10 buy + 10 sell)
- Подробные комментарии для indicators (RSI, EMA, Bollinger)

### v0.8.0 — `bd8a378` (2026-04-13)

Два раунда аудита (12 багов), новый механизм Bollinger Bands Adaptive Grid.

**Новый механизм: Bollinger Bands Adaptive Grid (включаемый/отключаемый)**

Адаптирует grid на основе позиции цены относительно полос Боллинджера + EMA фильтр для sell:

| Ситуация | Уровни (при shift=3) | Buy size | Sell size |
|---|---|---|---|
| Цена у нижней BB | 13B/7S | x1.5 | x1.0 |
| Цена ниже середины BB | 11B/9S | x1.0 | x1.0 |
| Цена нейтрально | 10B/10S | x1.0 | x1.0 |
| Цена у верхней BB + EMA bearish | 7B/13S | x1.0 | x1.5 |
| Цена у верхней BB + EMA bullish | 10B/10S | x1.0 | x1.0 |

Конфиг: `useBollingerAdaptive`, `bollingerBuyMultiplier`, `bollingerSellMultiplier`, `bollingerShiftLevels`.

**EMA фильтр — persistent вместо event:**
- Было: `emaCrossover === 'bearish'` (срабатывает на 1 свечу в момент пересечения)
- Стало: `emaFast < emaSlow` (постоянно пока fast ниже slow = нисходящий тренд)

**Аудит раунд 1 — 7 багов (коммит `afbc8d9`):**
- grid.ts: cancelled-check был unreachable (dead branch) — переставлен вверх
- grid.ts: counter-price использует actualPrice (реальный fill), а не filledPrice (лимитный)
- grid.ts: orphan-sell использует freeBal напрямую + guard для orderAmount<=0
- sync.ts: partial-fill-then-cancel detection (filled>0 независимо от статуса)
- exchange.ts: `tickSizeToDecimalPlaces(1)` возвращает 0 вместо 1
- combo-manager.ts: не обнуляет позицию после partial closePosition (SL/TP/trailing)
- state.ts: порог reducePosition унифицирован до 1e-12

**Аудит раунд 2 — 5 багов (коммит `91e8c65`):**
- combo-manager.ts: market panic чистит orderId в grid state после отмены buy-ордеров
- sync.ts: filled ордера при sync флипают level на counter-side (counter-order на следующем тике)
- indicators.ts: EMA seed = SMA(period) вместо одного значения (точные сигналы при малом количестве свечей)
- indicators.ts: NaN forward-fill вместо filter (сохраняет индексы массива для crossover detection)
- index.ts: shutdown race fix — `shuttingDown` flag блокирует тики при shutdown

### v0.9.0 — `6a9da6d` (2026-04-14)

Аудит раунд 3 — 8 багов (2 critical, 2 high, 4 medium).

**Критические фиксы:**
- **exchange.ts: retry дублирует ордера** — `withRetry` ретраил размещение ордеров при NetworkError/ECONNRESET (ордер уже на бирже, ответ потерялся). Теперь ВСЕ transient ошибки блокируют retry для order placement, не только timeout
- **combo-manager.ts: аллокация от USDT вместо портфеля** — `processPair` получал `currentBalance.total` (только USDT), а не `totalPortfolioUSDT`. При $200 в крипте и $100 USDT аллокации были 3x меньше нужного

**Высокий приоритет:**
- **combo-manager.ts: flash crash = ложный withdrawal** — grid fill ещё не записан в state, скачок портфеля принимался за вывод средств, обнуляя drawdown protection. Окно проверки trades 2→5 тиков + проверка наличия open grid orders
- **index.ts: shutdown race** — тик мог разместить ордер ПОСЛЕ того как shutdown отменил всё; двойной Ctrl+C запускал два shutdown параллельно. Теперь: ожидание завершения тика + guard `shutdownInProgress` + 3-й Ctrl+C = force exit

**Средний приоритет:**
- **state.ts: debounced write теряет fills при crash** — новый метод `saveCritical()` для немедленной записи позиций и трейдов; `.bak` файл для crash recovery на Windows (rename не атомарен)
- **grid.ts: orphan-sell бесконечный рост levels** — `existsAtPrice` проверял только уровни с `orderId`, отменённые биржей ордера создавали дубли каждый тик
- **grid.ts: double sell (counter + orphan)** — counter-sell + orphan-sell на одну крипту в одном тике (API не отражает залоченный баланс мгновенно). Трекинг `counterSellCommittedThisTick`
- **grid.ts: partial fill теряет объём** — уровень переключался на counter-side, оставшаяся часть buy забывалась. Теперь создаётся retry-level для оставшегося объёма

### v1.0.0 — `5494c64` (2026-04-14)

Переход на mainnet + Telegram-интеграция + оптимизация grid.

**Telegram-уведомления (`telegram.ts`):**
- Новый модуль `TelegramNotifier` — очередь сообщений, rate-limit 100ms, timeout 10s
- Startup message, summary каждые 60 тиков (~10 мин), fill-уведомления, алерты (SL/TP/halt/panic)
- Native `https` без внешних зависимостей, HTML parse mode
- Интеграция в `combo-manager.ts` — дублирует ключевые сообщения в Telegram

**Grid-оптимизация:**
- Раздельные buy/sell spacing: `gridSpacingPercent` (buy), `gridSpacingSellPercent` (sell)
- gridLevels: 20→14
- orderSizePercent: 14%→10%
- rebalancePercent: 2%→3%
- useEmaFilter: true→false (отключён)

**Аллокации:** SUI 25%→30%, SOL 40%→30%, XRP 35%→40%

**Risk:** stopLossPercent 14%→10%, cooldownAfterSLSec 7200→1800 (30 мин)

**Market Protection:** panicBearishPairsThreshold 2→999 (отключён)

**Mainnet:** USE_TESTNET=false, чистый bot-state.json

### v1.1.0 — `651e735` (2026-04-14)

Hot-reload конфигурации из config.jsonc, очистка Telegram-логов, улучшение валидации.

**Hot-reload config.jsonc:**
- Все параметры бота вынесены в `config.jsonc` (JSON с поддержкой `//` комментариев)
- Бот перечитывает config.jsonc каждые N тиков (`configReloadIntervalTicks`, по умолчанию 3)
- При `configReloadIntervalTicks=0` — fallback-проверка каждые 30 тиков (для возможности включить обратно)
- Hot-reload обновляет: grid, dca, risk, metaSignal, marketProtection, indicators, telegram
- НЕ обновляет: tickIntervalSec, syncIntervalSec, добавление/удаление пар (нужен перезапуск)
- При ошибке чтения/валидации — сохраняет предыдущий конфиг, логирует ошибку

**Telegram-логи:**
- Убраны HTML-теги из лога `bot.log` (в Telegram по-прежнему HTML)
- Укорочено: `Telegram sent: <текст до 50 символов>`

**Валидация конфигурации:**
- Все default-значения заменены на `defaultNum=-1` / `defaultBool=false`
- `validateConfig()` ловит пропущенные поля из config.jsonc (вместо молчаливых fallback)

**Grid-тюнинг:**
- gridLevels: 14→10, gridSpacingPercent: 0.6%→0.8%, gridSpacingSellPercent: 1.0%→1.4%, orderSizePercent: 10%→12%
- Аллокации: SUI 30%→25%, SOL 30%→40%, XRP 40%→35%

### v1.2.0 — `f90e992` (2026-04-15)

Управление ботом через Telegram-команды.

**Telegram-команды (`telegram.ts` + `combo-manager.ts`):**
- 7 команд: `/status`, `/stop`, `/run`, `/sellall`, `/buy`, `/orders`, `/cancelorders`
- Подтверждение [✅ Да / ❌ Нет] для опасных команд: `/stop`, `/sellall`, `/buy`, `/cancelorders`
- Non-blocking polling через `getUpdates` с `timeout=0`
- Безопасность: команды принимаются только от настроенного `chatId`
- Команды обрабатываются до проверки `halted` — `/buy` и `/run` работают при остановленном боте
- `lastUpdateId` персистится в state (нет повторной обработки команд при рестарте)
- `commandPollIntervalTicks` — частота опроса Telegram (по умолчанию каждый тик)

**Ручные покупки (`/buy`):**
- Два формата: `/buy SUI 10` (за USDT) и `/buy SUI BTC 10` (за BTC)
- Market order с проверкой баланса, precision, minAmount/minCost
- Пары не из конфига сохраняются в `manualPairs` (state.ts)
- Ручные пары отображаются в `/status`, `/orders` и продаются по `/sellall`

**Меню команд Telegram:**
- `register-commands.ts` — одноразовый скрипт для `setMyCommands` API
- Меню с описанием всех команд при нажатии `/` в чате с ботом

**Config hot-reload:**
- Перечитывание config.jsonc по MD5 хэшу — лог "Config reloaded" только при реальном изменении

**Утилиты:**
- `check-bybit.ts` — диагностический скрипт: балансы, открытые ордера, тикеры, последние закрытые ордера

### v1.2.1 — `473b24b` (2026-04-15)

Аудит Telegram-команд: 1 high, 4 medium багов.

**Фиксы:**
- **HIGH: lastUpdateId не сохранялся при рестарте** — рестарт мог повторно выполнить `/sellall` или `/buy`. Теперь `telegramUpdateId` персистится в `bot-state.json`
- **MEDIUM: `/stop` подсказывал `/start` вместо `/run`** — пользователь не мог возобновить бота по подсказке
- **MEDIUM: callback_data без проверки длины** — Telegram молча обрезает данные >64 байт, длинные аргументы `/buy` могли исказиться. Добавлена валидация
- **MEDIUM: ложный reload конфига на первом тике** — hash инициализировался пустой строкой, первая проверка всегда считала конфиг "изменённым". Теперь hash вычисляется в `init()`
- **MEDIUM: hot-reload пересоздавал TelegramNotifier** — терялась очередь сообщений и сбрасывался `lastSummaryTick` (summary в Telegram приходило чаще 10 мин). Теперь `updateConfig()` вместо `new TelegramNotifier()`

### v1.3.0 — `b89a2cf` (2026-04-15)

Новые функции и улучшения Telegram-уведомлений.

**Новое:**
- **Команда `/cancelorders`** — отменяет все ордера (grid + manual), сбрасывает grid, останавливает бота. Требует подтверждения [✅ Да / ❌ Нет]
- **Таймаут подтверждения** — кнопки [Да/Нет] устаревают через `confirmationTimeoutSec` (60с по умолчанию). Защита от случайного нажатия старых кнопок
- **Унифицированная подсказка halt** — все сообщения о halt (drawdown, TP, SL, trailing SL, команды) содержат подсказку `Для возобновления: /run или halted→false в bot-state.json`
- **Telegram-алерты для pair halt** — consecutive SL и cooldown=0 halt теперь отправляют алерт в Telegram (раньше только в лог)
- **Константа `HALT_HINT`** — текст подсказки вынесен в глобальную переменную, единая точка изменения

**Конфиг:**
- `confirmationTimeoutSec: 60` — таймаут подтверждения Telegram-команд (0 = без таймаута)
- `commandPollIntervalTicks: 1` — проверка команд каждый тик (было 3)
- Торговые пары: DOT/USDT, NEAR/USDT, ADA/USDT (SUI/SOL/XRP закомментированы)

### v2.0.0 (2026-04-16–17)

Крупное обновление: auto-adaptive grid spacing, volatility analyzer, lock-file, новые Telegram-команды.

**Auto-adaptive spacing (главная фича):**
- Новый общий модуль `src/volatility.ts` — анализ волатильности (ATR%, перцентили размаха, weighted spacing)
- Бот автоматически пересчитывает оптимальный spacing каждые N минут (`autoSpacingIntervalMin`)
- `autoSpacingPriority`: `"off"` / `"config"` (лог) / `"auto"` (применять)
- `autoSpacingSafetyMarginPercent` — коэффициент недоверия (вычитать N% из расчёта)
- Fire-and-forget выполнение — не блокирует торговлю
- Force-rebalance всех пар после первого расчёта при старте
- Floor: buySpacing >= 0.3%, sellSpacing >= buySpacing + 0.3%
- Результат в лог + Telegram с `[AUTO]` / `[CFG]` пометкой

**Per-pair grid spacing:**
- Каждая пара может иметь свой `gridSpacingPercent` / `gridSpacingSellPercent`
- Fallback на глобальные значения из секции `grid`
- Применяется в initGrid, counter-orders, orphan-sell, sync

**Volatility Analyzer (standalone скрипт):**
- `analyze-volatility.ts` — CLI скрипт для ручного анализа волатильности
- 6 символов × 4 периода (24h/3d/7d/14d) × 3 таймфрейма (15m/1h/4h)
- `--json` для машиночитаемого вывода, `--file <path>` для записи в UTF-8
- Рефакторинг: использует общий модуль `src/volatility.ts`

**Новые Telegram-команды:**
- `/stats` — статистика торговли по парам (buys/sells/spent/earned/PnL)
- `/regrid` — сброс сетки (cancel orders) + перестройка с текущим spacing. Требует подтверждения
- Меню команд регистрируется автоматически при каждом старте бота

**Telegram summary улучшения:**
- Стоимость ордеров в USDT (price × amount) вместо диапазона цен
- GridLevelState теперь хранит `amount`
- Формат: `2B [15.42$]`, `3S [23.10$] + 2Pend [15.68$]`
- Panic/BTC watchdog статус в summary
- Sell-ордера: `3S` для активных, `3Pend` для pending (было `3S pend`)

**Статистика торговли (bot-state.json):**
- Кумулятивная статистика по каждой паре: buys, sells, spent, earned, fees, PnL
- Автоматически обновляется при каждой сделке через `addTrade()`
- Переживает рестарты

**Lock-file:**
- `bot.lock` предотвращает запуск двух экземпляров бота одновременно
- Проверяет жив ли процесс по PID, stale lock перезаписывается
- Удаляется при shutdown (soft/hard/force) и при crash

**Hot-reload:**
- `syncIntervalSec` теперь hot-reload (было только при рестарте)
- `manager.getConfig()` — доступ к актуальному config из index.ts
- ExchangeSync получает spacing через `spacingResolver` callback (учитывает auto-spacing)

**Config:**
- `autoSpacingEnabled` убран, заменён на `autoSpacingPriority` (off/config/auto)
- `autoSpacingIntervalHours` переименован в `autoSpacingIntervalMin` (в минутах)
- `rebalancePercent`: 3% → 2%
- Лог-сообщения auto-spacing на английском

**Утилиты:**
- `reset-grid.ts` — подробные комментарии (что делает, что сохраняет, когда использовать)
- `restart-bot.ts` — команды поиска процесса в комментариях

### v2.1.0 — `fb8a3ac` + `210c58d` (2026-04-17–18)

Новые Telegram-команды (заморозка, sellgrid, /start), midpoint guard, ticker cache, авто-сортировка /stats.

**Новые Telegram-команды:**
- **`/start`** — приветствие со списком всех команд по секциям (📊 Мониторинг / 🛒 Торговля / 🧊 Заморозка / 🔻 Sellgrid / ⚙️ Управление)
- **`/freezebuy XRP`** + **`/unfreezebuy XRP`** — заморозка автоматических покупок по валюте. Отменяются все buy-ордера, sell продолжают работать. State `blockedBuyBases`. Wizard с кнопками если без args. Маркер 🧊 в /status, /stats, BOT SUMMARY. На рестарте sync.ts отменяет live buy-ордера для frozen баз. /unfreezebuy делает force-rebalance для актуализации buy-уровней
- **`/sellgrid XRP`** + **`/unsellgrid XRP`** — режим ladder-распродажи. После каждого sell fill ставится новый sell выше (вместо counter-buy), так позиция плавно распродаётся вверх. Авто-включает freeze. При истощении позиции (< minAmount) — авто-выход + Telegram alert. Маркер 🔻

**Midpoint Sell Guard (вместо raise-to-break-even):**
- Если spacing-цена counter-sell ниже break-even → берётся **midpoint** между spacing и break-even
- Если midpoint ниже `avgEntry × (1 − maxSellLossPercent/100)` → sell не ставится (skip), полагаемся на orphan-sell или существующие sell-ордера
- Применяется и в Counter-Sell Guard (после buy fill), и в Grid Sell Guard (placeGridOrders), и в rebalance
- Новые config: `minSellProfitPercent` (0.3 — минимум прибыли для безубыточности), `maxSellLossPercent` (1 — макс убыток в midpoint), `orphanSellMaxPerTick` (5–10)
- Все hardcoded `× 1.003` заменены на `× (1 + minSellProfitPercent/100)` через config

**`/stats` улучшения:**
- Сортировка пар по PnL **descending** (прибыльные первыми, убыточные последними)
- Per-pair строка с текущей ценой и **дистанцией до ближайшего buy/sell**: `NowPrice 1.9380 ↓ -0.0330 (-1.70%) ↑ +0.0480 (+2.48%) USDT`
- **Ticker cache** в `exchange.ts` (15с TTL) — при наличии свежей цены из тика бота API не дёргается, /stats отдаёт мгновенно
- Параллельный fetch несвежих тикеров батчами по `parallelPairs`

**`/buy` wizard:**
- Без args — inline-клавиатура с валютами + кнопками `[Другая]` и `[Ввести вручную]`
- Клик по валюте → меню сумм `[$5] [$10] [$15] [$20] [$50]`
- Клик по сумме → расчёт amount по тикеру + диалог подтверждения
- Маркер 🧊 на кнопке если валюта заморожена + предупреждение при подтверждении
- Синтаксис изменён: `/buy SUI BTC 10` (вместо `/buy SUI/BTC 10`)

**Auto-spacing улучшения:**
- Лог: pair names выровнены по самому длинному, regime сокращён до 4 букв (`norm`/`high`/`low `)
- Telegram-сообщение: моноширинное выравнивание через `<pre>`, читаемая колонка

**BOT SUMMARY:**
- Динамическая иконка тренда `⬆️`/`⬇️` (по знаку PnL) перед заголовком
- Per-pair строка с PnL: `SOL/USDT (9B/11S) PnL: +19.14 USDT (+31.5%)`
- Pending sell без `[$0]` (только число)

**Telegram tweaks:**
- Команды добавлены в BotFather menu через `setMyCommands` при старте
- Callback dedup (`processedCallbackIds` Set с FIFO eviction) — защита от двойного клика
- Подтверждения для `/freezebuy`, `/unfreezebuy`, `/sellgrid`, `/unsellgrid`, `/regrid`

**Bug fixes (по аудиту):**
- `state.addManualPair` / `removeManualPair` → `saveCritical` (раньше `save` с debounce — теряли state при краше)
- `state.blockedBuyBases` / `sellGridBases` через `saveCritical`
- Counter-sell skip в sellgrid-режиме keeps level as `'sell'` (orphan-sell покрывает), в обычном режиме flips в `'buy'`
- `getPrecision` в sellgrid auto-exit обёрнут в try-catch
- `validateConfig` enforces новые grid-параметры (без них бот падает с понятной ошибкой)

**README + Hot-reload:**
- Changelog переупорядочен по возрастанию (v0.7→v2.x), Lock-файл секция перенесена выше
- `configReloadIntervalTicks: 0 → 3` (30с вместо fallback 5 мин)
- `commandPollIntervalTicks: 2 → 1` (10с вместо 20с — для плавного wizard /buy)
- `confirmationTimeoutSec: 60 → 120` (2 мин на подтверждение)

### v2.2.0 (2026-04-18)

Counter-Sell Midpoint Trailing — замена старого Trailing Sell-Down.

**Старый механизм (`sellTrailingDownHours`):** каждый sell старше 12ч сдвигался к `max(breakEven, currentPrice × 1.005)`, опускался до текущего avgEntry × 1.005 независимо от истории — при сильном усреднении вниз ломал изначально прибыльные sell-ы.

**Новый механизм (`counterSellTrailStepHours`, default 4ч):**

Только для **counter-sell** ордеров (созданных после buy-fill, не для grid-init/orphan-sell). В `GridLevelState` добавлены поля `oldBreakEven`, `originalPlannedSellPrice`, `virtualNewSellPrice`, `nextStepAt`.

Триггер — **split rebalance DOWN** (цена упала > 2% от центра сетки):

1. **Шаг 1.** Фиксируется `virtualNewSellPrice = currentPrice × (1 + sellSpacing%)`
2. **Шаг 2.** Если `virtualNewSellPrice < oldBreakEven`: ордер переставляется на `max(oldBreakEven, midpoint(originalPlanned, virtualNew))`. Запускается таймер 4ч
3. **Шаг 3.** Иначе: ордер сразу на virtualNewSellPrice, halving не нужен
4. **Шаг 4 (каждый тик по истечении таймера).** `T = midpoint(currentSellPrice, virtualNew)` — **без** защиты oldBreakEven. Если `|T - virtualNew| / virtualNew ≤ 5%` → финиш на virtualNew. Иначе → перестановка на T, новый таймер. Двоичный поиск: ~6-7 шагов до цели

**Защита oldBreakEven применяется только на первом шаге** — после этого ордер может опускаться ниже oldBreakEven через midpoint halving. Это сознательный компромисс: первый шаг даёт шанс отскоку, но если рынок не восстанавливается — постепенно принимаем реальность.

**Partial fill:** retry-level наследует всю metadata (oldBreakEven, originalPlannedSellPrice, virtualNewSellPrice, nextStepAt).

**Конфиг:** `grid.counterSellTrailStepHours: 4` (0 = выключено). Валидация: 0-72ч.

**Bug fixes:**
- Counter-sell skip в midpoint guard чистит counter-sell metadata
- initCounterSellTrailing корректно обрабатывает level без orderId (externally-cancelled)
- Finish-branch в шаге 4 чистит nextStepAt и virtualNewSellPrice

### v2.3.0 — `97aae42` + `0f91254` + `e4f5508` (2026-04-18)

Per-pair state control, bidirectional config sync, RSI/EMA/BB в summary, фиксы.

**Per-pair `state` в config.jsonc:**
- Каждая пара поддерживает поле `state`: `"unfreeze"` / `"freezebuy"` / `"sellgrid"` / `"freeze"`
- Hot-reload: изменение `state` в конфиге подхватывается автоматически (~30с), применяется без рестарта
- Стартовое применение: при запуске бота состояния из конфига применяются к парам
- Пример: `{ "symbol": "XRP/USDT", "allocationPercent": 12, "state": "sellgrid" }`

**Новые Telegram-команды `/freeze` / `/unfreeze`:**
- **`/freeze XRP`** — полная заморозка: grid/DCA/meta не работают, но SL/TP/TSL продолжают защищать позицию. Маркер 🧊❄️
- **`/unfreeze XRP`** — снять полную заморозку + force-rebalance для актуализации сетки
- State `frozenPairs` в `bot-state.json`, переживает рестарты
- Wizards с inline-кнопками (как `/freezebuy`)

**Bidirectional config sync (`src/config-writer.ts`):**
- Новый модуль для атомарной записи полей в `config.jsonc` (через .tmp + rename, сохраняет комментарии)
- Telegram-команды пишут `state` обратно в конфиг: `/freeze` → `"freeze"`, `/unfreeze` → `"unfreeze"`, `/freezebuy` → `"freezebuy"`, `/unsellgrid` → `"unfreeze"`
- `autoSpacingPriority: "auto"` — после пересчёта spacing значения `gridSpacingPercent` / `gridSpacingSellPercent` синхронизируются в конфиг для каждой пары
- После записи `lastConfigHash` обновляется, чтобы избежать ложного hot-reload

**RSI / EMA / BB в summary:**
- Per-pair строки в BOT SUMMARY (лог и Telegram) содержат: `RSI: 54.3 EMA: bullish BB: below_middle`
- Данные берутся из `lastIndicatorsPerPair` — отображают состояние последнего тика

**TSL: деактивация через 999:**
- `trailingSLPercent: 999` + `trailingSLActivationPercent: 999` — полное отключение Trailing SL без рестарта
- Валидация снята: верхняя граница `trailingSLPercent` убрана (раньше требовалась < `takeProfitPercent`)

**Bug fixes:**
- **Hot-reload state detection**: `prevPairs` теперь сохраняется ДО `this.config = newConfig`. Раньше сравнение всегда давало oldState === newState (массивы уже одинаковые)
- **Freeze охватывает все affected symbols**: `applyPairState(freeze)` итерирует все пары (включая `manualPairs`) с тем же base-тикером, как и `cmdFreezeBuy`
- **Zombie sell levels**: sell-уровни с `amount=0`, без `orderId` и без `filled` (артефакт после TSL partial-fill) отфильтровываются в `setGridLevels` и больше не зависают в pending

### v2.4.0 (2026-04-19)

Аудит конфига, `qtySigmas`, защита metadata при `/regrid`, фиксы dust-loop и Telegram HTML.

**`qtySigmas` — управление уровнем уверенности auto-spacing:**
- Новый параметр `grid.qtySigmas` (допустимые значения: 1, 2, 3) определяет сигму для `trimOutliers()` в `volatility.ts`
- 1σ — агрессивная фильтрация выбросов (compact spacing), 3σ — консервативная (широкий spacing)
- Передаётся в `analyzeAllSymbols` → `analyzeSymbol` → `trimOutliers`
- Валидация в `config.ts`: только `[1, 2, 3]` — иные значения запрещены

**`/regrid` сохраняет counter-sell metadata:**
- Раньше `/regrid` обнулял все grid-уровни через `setGridLevels(sym, [])`, теряя `oldBreakEven` и `originalPlannedSellPrice`
- Теперь `cmdResetGrid` перед очисткой сохраняет sell-уровни с заполненной metadata, сбрасывает `orderId`/`filled`/`virtualNewSellPrice`/`nextStepAt` (trailing перезапускается), сохраняет `oldBreakEven` + `originalPlannedSellPrice`
- `initGrid` подхватывает preserved sells как `existingSells` (line 304 в `grid.ts`) — механизм уже был готов
- Trailing продолжает работу после `/regrid` с теми же защитами oldBreakEven

**`allocationPercentMode: "auto"` при удалении пары:**
- `applyPairState('deleted')` теперь вызывает `rewritePairAllocations` — пересчитывает доли для оставшихся активных пар
- Раньше пересчёт происходил только в `cmdRemoveToken`, теперь и при hot-reload смены состояния на `deleted`

**Новые Telegram-команды `/addtoken` / `/removetoken`:**
- `/addtoken` — wizard добавления новой валюты в торговлю
- `/removetoken` — wizard удаления (переводит в `deleted`, при `auto` режиме пересчитывает аллокации)
- Добавлены в меню `setMyCommands` (`registerCommands`)

**Фиксы:**
- **Dust loop** (`applyPairState('freezebuy')` не чистил `sellGridBases`): пара в `sellgrid` + `dustThresholdUSDT` каждый тик заново переводила себя в `freezebuy`. Добавлен `removeSellGridBase(base)` в ветку freezebuy
- **Telegram HTML 400 ошибка**: символ `<` в dust-алерте (`остаток < X$`) интерпретировался как HTML-тег. Исправлено на `&lt;`
- **Dust: freeze → freezebuy**: пара с исчерпанным sellgrid переходит в `freezebuy` (а не `freeze`) — оставшиеся sell-ордера продолжают исполняться
- **`orphanSellMaxPerTick` валидация**: верхний лимит поднят с 20 до 100 (конфиг использует 30)
- **`config-writer.ts` Bug #7**: определение конца блока `pairs` теперь пропускает строки-комментарии (`//`)

**README:**
- Добавлена секция «Состояния пар» с описанием всех состояний (`unfreeze`, `freezebuy`, `sellgrid`, `freeze`, `deleted`) и правилами авто-переходов
- Расширена таблица Telegram-команд: добавлены `/addtoken`, `/removetoken`, уточнено поведение `/buy` и `/regrid`
- Новая подсекция «Поведение `/freeze` и `/buy` на замороженной паре»

### v2.5.0 (2026-04-19)

Унификация формата логов, фикс allocationPercent при удалении пары, выравнивание auto-spacing.

**Единый формат логов (все ордера и сделки):**

Вместо трёх несовместимых стилей — единая схема с префиксом источника:

```
[grid]   SUI/USDT    buy  filled   6.09 @ 0.9581
[grid]   SUI/USDT    sell filled   6.08 @ 1.0999
[grid]   SOL/USDT    buy  placed   0.0673 @ 88.43    (counter-order)
[grid]   AAVE/USDT   sell placed   0.0564 @ 105.29   (counter-order)
[grid]   SUI/USDT    sell placed   6.08 @ 0.9921     (orphan-sell)
[grid]   RENDER/USDT sell placed   3.01 @ 1.920      (sellgrid-ladder)
[grid]   SUI/USDT    buy  placed   6.09 @ 0.9581     (grid-init)
[grid]   DOT/USDT    sell trailed  1.400 → 1.365     (counter-sell, protected halving, goal=1.318)
[grid]   DOT/USDT    sell trailed  1.329 → 1.324     (counter-sell, halving, goal=1.318)
[grid]   DOT/USDT    sell trailed  1.329 → 1.318     (counter-sell, halving done)
[grid]   DOT/USDT    sell trailed  1.329 → 1.318     (counter-sell, direct)
[dca]    AAVE/USDT   buy  market   0.0565
[meta]   SUI/USDT    buy  market   5.0
[meta]   SUI/USDT    sell market   6.08
[risk]   SUI/USDT    sell market   6.08              (stop-loss)
[risk]   SUI/USDT    sell market   6.08              (take-profit)
[risk]   SUI/USDT    sell market   6.08              (trailing-stop-loss)
[risk]   SUI/USDT    sell market   6.08              (portfolio take-profit)
[manual] SUI/USDT    buy  market   10.0
[manual] SUI/USDT    sell market   6.08              (sell-all)
```

Изменения:
- `exchange.ts`: убраны логи `LIMIT BUY/SELL` (grid.ts логирует с контекстом), `MARKET BUY/SELL` → новый формат с prefix+label, `cancelOrder` → DEBUG уровень
- `grid.ts`: все fill/placed/trailed логи переведены на новый формат; `counterOrderLabel` различает `counter-order` vs `sellgrid-ladder`
- `combo-manager.ts`: market-ордера получают label: `stop-loss`, `take-profit`, `trailing-stop-loss`, `portfolio take-profit`, `sell-all`

**Фикс `allocationPercent` при удалении пары:**
- `cmdRemoveToken` и `applyPairState('deleted')`: удалённая пара теперь получает `allocationPercent: 0` в config.jsonc (раньше оставалось старое значение)
- Оставшиеся активные пары пересчитываются как прежде

**Выравнивание auto-spacing лога:**
- `1.2%/1.7%` → `1.20%/1.70%` (`.toFixed(2)` на все значения); обе колонки `auto=` и `cfg=` теперь одинаковой ширины

## Важные замечания

- Обязательно начинайте с `USE_TESTNET=true` и небольших сумм
- При маленьком капитале (<$200) ордера могут быть ниже minAmount/minCost биржи — бот пропустит их с логом
- При свежем старте с уже имеющейся криптой на бирже — position tracking начинается с 0, SL/TP не сработает на купленные вручную монеты
- Удалите `bot-state.json` при смене пар или после крупных обновлений
- Это не финансовый совет. Торговля несёт риск потери средств.
