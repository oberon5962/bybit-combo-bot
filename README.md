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
| gridLevels | `5` (только buy-уровни; sell-уровней всегда `GRID_SELL_LEVELS=20`, константа в `src/types.ts`) |
| gridSpacingPercent | per-pair (fallback 1.0%), auto-spacing перезаписывает |
| gridSpacingSellPercent | per-pair (fallback 1.4%), auto-spacing перезаписывает |
| autoSpacingPriority | `"auto"` (статистика применяется + force-rebalance при изменении) |
| autoSpacingIntervalMin | `180` (каждые 3ч) |
| autoSpacingSafetyMarginPercent | `0` (без запаса — доверяем статистике) |
| orderSizePercent | 15% от аллокации пары |
| rebalancePercent | 2% (вверх или вниз от центра) |
| rsiOverboughtThreshold | 65 (100 = отключить) |
| useEmaFilter | `true` (grid-buy блокируется при `emaFast < emaSlow`) |
| useBollingerAdaptive | true |
| bollingerBuyMultiplier | 1.5x (у нижней BB) |
| bollingerSellMultiplier | 1.5x (у верхней BB + bearish EMA) |
| bollingerShiftLevels | 2 (сдвиг buy-уровней: при bearish `+2`, при bullish `-2`; cap `buyLevels ≥ 1`) |
| counterSellTrailStepHours | 24 (шаг midpoint-halving для counter-sell после split rebalance DOWN) |
| minSellProfitPercent | 0.5% (break-even минимум: покрывает round-trip fees 0.2% + запас 0.3%) |
| orphanSellMaxPerTick | 30 |

**Indicators (`config.jsonc → indicators`):**

| Параметр | Значение |
|---|---|
| rsiPeriod | 14 |
| emaFastPeriod | `7` (короче = быстрее реагирует на смену тренда) |
| emaSlowPeriod | `15` |
| bollingerPeriod | 20 |
| bollingerStdDev | 2 |

**`maxOpenOrdersPerPair`** вычисляется автоматически: `gridLevels + GRID_SELL_LEVELS + 4` = `5 + 20 + 4 = 29`.

### Risk Management

| Параметр | Значение |
|---|---|
| stopLossPercent | 20% |
| takeProfitPercent | 100% |
| trailingSLPercent | 999 (выключен) |
| trailingSLActivationPercent | 999 (выключен) |
| maxDrawdownPercent | 25% |
| portfolioTakeProfitPercent | 100% (продать всё когда портфель +100% от старта) |
| cooldownAfterSLSec | 1800 (30 минут) |
| cooldownMaxSL | 2 (2 SL подряд = halt) |

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

Размещает сетку лимитных ордеров на покупку ниже текущей цены и на продажу выше. Когда покупка исполняется — бот ставит counter-sell ордер выше (+ gridSpacingSell%). Когда продажа исполняется — ставит counter-buy ниже. Зарабатывает на каждом колебании цены внутри диапазона.

**Количество уровней:**
- `buyLevels = max(1, gridLevels + bollingerShiftLevels)` — **только buy-сторона** задаётся через `gridLevels` в config
- `sellLevels = GRID_SELL_LEVELS = 20` — **всегда константа** в коде (`src/types.ts`). Мотивация: sell-сторона обслуживает ладдер из counter-sells после buy-fills + orphan-sells, её размер не зависит от рыночной волатильности, а определяется глубиной возможной просадки.
- Общее число уровней на паре: `buyLevels + 20` (до 25 при `gridLevels=5`)

**Bollinger Bands Adaptive Grid:** когда цена у нижней полосы BB — `buyLevels += bollingerShiftLevels` (больше buy-уровней) и увеличенный orderSize (×`bollingerBuyMultiplier`). Когда у верхней BB + bearish EMA — увеличенный sell size (×`bollingerSellMultiplier`). При bullish EMA sell не усиливается. Валидация: `0 ≤ bollingerShiftLevels < gridLevels` (чтобы buyLevels не ушёл в 0 при bullish sдвиге `-shift`).

**Fallback при нехватке капитала (Bollinger multiplier):**

Если умноженный размер (1.5x) не помещается в свободный баланс — бот **не пропускает** ордер, а выставляет **столько сколько есть**:

- **Buy:** хотим купить на $7.5 (1.5x), есть $5 USDT → считаем сколько монет можем купить на $5 (с учётом minAmount и minCost) → покупаем это количество. Лог: `Buy reduced (low USDT): 0.06 → 0.04 (67% of target)`.
- **Sell:** хотим продать 10 SUI (1.5x), есть 7 SUI → продаём все 7 (если >= minAmount и minCost × price). Лог: `Sell reduced (low SUI): 10 → 7 (70% of target)`.
- **Skip только если** даже минимальный размер (minAmount/minCost) не помещается в баланс.

Это предотвращает "замораживание" торговли когда на 1.5x не хватает — бот всё равно торгует по доступному размеру.

**Фильтры для buy-ордеров:**
- RSI > `rsiOverboughtThreshold` (65) — grid buy пропускается, причина `overbought`
- **EMA фильтр (`useEmaFilter: true`):** если `emaFast < emaSlow` на 5-мин свечах — grid buy блокируется, причина `EMA bearish`. EMA считается по closes, формула `EMA[i] = α × price + (1-α) × EMA[i-1]`, где `α = 2/(period+1)`. Текущие периоды `7/15`: fast реагирует за ~35 мин, slow за ~1ч15мин. Короткие периоды = быстрее подхватывает отскоки, но больше whipsaw в боковике
- Скип-причины surface в BOT SUMMARY в колонке `buy:<reason> sell:<reason>` (padded автоматически по самой длинной строке summary)

**Важно: оба фильтра (EMA bearish и overbought) действуют ТОЛЬКО на размещение новых buy-ордеров.**

`isBuyAllowed()` вызывается в `placeGridOrders` **только для уровней без `orderId`** — то есть для тех, где ордер ещё не стоит на бирже. Уровни с `orderId` (существующие ордера) пропускаются до проверки фильтра (`if (level.orderId || level.filled) continue`). Следствия:

- Когда EMA стала bearish — существующие buy-ордера на бирже **остаются нетронутыми** и продолжают висеть
- Если fill произошёл пока EMA bearish — освободившийся уровень останется пустым; ордер на его место не будет поставлен до смены EMA на bullish
- Фильтр **не отменяет** ни один ордер. Единственное, что активно отменяет buy-ордера — `rebalance DOWN` (drift >2% вниз) через `cancelBuySide()`

### Перестройка сетки — 3 типа

В коде есть **три разных механизма** пересборки сетки, которые легко спутать. Таблица сравнения:

| Тип | Когда срабатывает | Что отменяется | Что пересоздаётся | Halving-meta |
|-----|-------------------|----------------|-------------------|--------------|
| **Auto-rebalance DOWN** (split) | drift >2% И цена упала, cooldown 5 мин прошёл | `cancelBuySide()` — **только buy-ордера** | **только buy-сторона** | Runtime halving **активируется** через `initCounterSellTrailing(currentPrice)` на всех counter-sells с anchors. Sell-ордера остаются висеть на высоких ценах |
| **Auto-rebalance UP** | drift >2% И цена выросла, cooldown 5 мин прошёл | `cancelAllPreserveCounterSellMeta()` — **все** ордера, preserve **только** counter-sells (sellSource='counter') | **обе стороны** с нуля вокруг новой цены. Ladder строится от `currentPrice + sellSpacing × i` | Counter-sell anchors сохраняются; runtime halving (`virtualNewSellPrice`, `nextStepAt`) сбрасывается |
| **Force-rebalance** (`setGridCenterPrice(sym, 0)`) | см. «Триггеры» ниже | `cancelAllPreserveCounterSellMeta()` — **все** ордера, preserve **только** counter-sells | **обе стороны** от currentPrice. Preserved counter-sells сосуществуют с новым ladder'ом через fuzzy-проверку (слот пропускается, если в пределах 0.5×sellSpacing от preserved) | Halving **НЕ активируется** автоматически — стартует при следующем split rebalance DOWN |

**Ключевые различия:**
- **Auto-rebalance DOWN** — единственный механизм, который **активирует halving**. Только он трогает buy-сторону изолированно.
- **Auto-rebalance UP** и **Force-rebalance** — оба сносят всё и пересоздают вокруг новой цены. Разница только в триггере: UP реагирует на фактический drift, force — на явный reset центра.
- **Cooldown 5 мин** действует только на auto-rebalance (drift-based), не на force-rebalance.

**Триггеры Force-rebalance** (6 мест в коде):
1. **Startup при пустом center** — первый запуск / миграция старого state ([grid.ts:252-263](src/strategies/grid.ts#L252-L263))
2. **Auto-spacing изменил spacing** ([combo-manager.ts:252](src/strategies/combo-manager.ts#L252)) — при `autoSpacingPriority: "auto"` для каждой изменённой пары (`changedPairs`)
3. **Telegram `/unsellgrid BASE`** ([combo-manager.ts:2058](src/strategies/combo-manager.ts#L2058)) — выход из sellgrid-режима
4. **Telegram `/unfreezebuy BASE`** ([combo-manager.ts:2087](src/strategies/combo-manager.ts#L2087)) — разморозка после freezebuy
5. **`applyPairState → unfreeze`** — смена state в config.jsonc или через Telegram wizard
6. **Telegram `/regrid`** — явная команда "построй grid заново"

Механика force-rebalance: `setGridCenterPrice(sym, 0)` → на следующем тике `initGrid` видит `gridCenter <= 0` → пишет лог `Grid force-rebalance for X: center was reset` → `cancelAllPreserveCounterSellMeta()` → реинициализация сетки с `gridCenter = currentPrice`.

### Типы sell-ордеров и их preserve-семантика

Каждый sell-уровень в `GridLevelState` имеет поле `sellSource` — маркер источника, определяющий поведение при force-rebalance:

| `sellSource` | Источник | `oldBreakEven` | Preserve? | Halving? |
|--------------|----------|----------------|-----------|----------|
| `'counter'` | Flip buy→sell при fill (конкретная покупка) | `actualPrice × (1 + minSellProfitPercent/100)` — break-even этой конкретной покупки | ✅ да | ✅ да (при split rebalance DOWN) |
| `'orphan'` | Orphan-sell от free-balance SUI (не привязан к конкретному buy) | `avgEntryPrice × (1 + minSellProfitPercent/100)` — position-level | ❌ нет (ladder пересобирается) | ❌ нет |
| `'initial'` | Initial-grid-sell (первичная сетка) | Position-level | ❌ нет | ❌ нет |
| `undefined` | Legacy (pre-feature) | Детектируется эвристикой | Если `oldBreakEven` отличается от position-level на > 0.05% → `counter`; иначе `initial` | По классификации |

**Зачем разделение:**
Раньше все sells с `oldBreakEven` preserve'ились при force-rebalance — включая «синтетические» anchors от initial-grid-sell (все с одинаковым `oldBreakEven = avgEntry × 1.005`). Это приводило к **stuck ladder**: преэкзистинг sells на высоких ценах (с прошлых high-price дней) удерживали верх ладдера, новый ладдер строился выше них, а между currentPrice и старыми sells оставался большой gap.

**После разделения:** preserve только настоящие counter-sells (от конкретных buy-fills). Ladder всегда строится от `currentPrice`, покрывая диапазон `currentPrice → currentPrice + sellSpacing × 20`. Старые synthetic-anchors не мешают.

### Auto-adaptive spacing

Бот автоматически пересчитывает оптимальный `buySpacing` / `sellSpacing` на основе статистики волатильности (ATR%, перцентили размаха свечей, взвешенное среднее по 4 периодам и 3 таймфреймам). Управляется параметром `autoSpacingPriority`:

| Режим | `autoSpacingMap` (память) | `config.jsonc` | Force-rebalance | Лог / Telegram |
|-------|---------------------------|----------------|-----------------|----------------|
| `"off"` | не трогается | не пишется | нет | лог: `Auto-spacing completed but was disabled — result not applied` |
| `"config"` | `setAutoSpacing(newMap)` ✓ | **не пишется** | нет (значения в памяти, но grid их НЕ использует — см. [grid.ts:112](src/strategies/grid.ts#L112) проверяет именно `priority === 'auto'`) | лог: `Auto-spacing done`, помечено `[CFG]` |
| `"auto"` | `setAutoSpacing(newMap)` ✓ | **пишется** (`updatePairSpacingInConfig`) только для `changedPairs` | **да**, `grid.forceRebalance(sym)` для каждой `changedPair` | лог + Telegram с пометкой `[AUTO]`, строка `Auto-spacing: force-rebalancing N pair(s) with new values` |

**Pipeline при `priority: "auto"`** (одна транзакция внутри `runAutoSpacing()`):
1. Загрузить свечи (72 API вызова Bybit, ~40 сек)
2. Посчитать ATR%, перцентили, weighted spacing с `safetyMargin`
3. **Hybrid floor** (защита от низких значений при плоском рынке) [combo-manager.ts:185-211](src/strategies/combo-manager.ts#L185-L211):
   - `buy = max(rawBuy, minSellProfitPercent / 2)` — мягкий floor (0.25% при дефолте). Защищает от слишком плотного buy-ladder (5 buy в 0.5% диапазоне).
   - `sell = max(rawSell, minSellProfitPercent)` — жёсткий floor (0.5%). Гарантирует counter-sell markup минимум 0.5% = +0.3% net после fees.
   - При срабатывании floor в лог добавляется аннотация `(too low X)` с raw-значением.
4. Положить `newMap` в `autoSpacingMap` (память grid) → [combo-manager.ts:219](src/strategies/combo-manager.ts#L219)
5. Определить `changedPairs` через `spacing.toFixed(2) !== cfgSpacing.toFixed(2)` [combo-manager.ts:229](src/strategies/combo-manager.ts#L229)
6. Для каждой `changedPair`: записать новые значения в `config.jsonc` (функция `updatePairSpacingInConfig`) [combo-manager.ts:240](src/strategies/combo-manager.ts#L240)
7. Обновить `lastConfigHash` (чтобы hot-reload не сработал повторно от собственной записи)
8. Для каждой `changedPair`: вызвать `grid.forceRebalance(sym)` [combo-manager.ts:252](src/strategies/combo-manager.ts#L252)
9. На следующем тике сетки этих пар пересобираются с новым spacing (см. таблицу «Force-rebalance» выше)
10. Отправить итоговый отчёт в Telegram

### Примеры лога auto-spacing с hybrid floor

```
# Штатный случай (все raw значения выше floor):
  DOT/USDT:    auto=1.16%/1.66% cfg=1.16%/1.66% regime=norm [AUTO]
  SOL/USDT:    auto=0.84%/1.34% cfg=0.84%/1.34% regime=norm [AUTO]

# Sell floor сработал (raw sell был ниже 0.5%):
  DOT/USDT:    auto=1.16%/0.50% (too low 0.10) cfg=1.16%/1.66% regime=norm [AUTO]

# Оба floor сработали (raw buy < 0.25 и raw sell < 0.5):
  SOL/USDT:    auto=0.25%/0.50% (too low buy=0.10 sell=0.10) cfg=0.84%/1.34% regime=norm [AUTO]

# Только buy floor сработал (редкий случай — raw sell уже был выше 0.5):
  ADA/USDT:    auto=0.25%/0.80% (too low buy=0.10) cfg=1.07%/1.57% regime=norm [AUTO]
```

**Математика profit на защищённых значениях** (buy=0.25, sell=0.5):
- Counter-sell (buy@X×0.9975 → sell@X×0.9975×1.005 = X×1.00249): markup 0.5% → net **+0.3%** после fees
- Full cycle (sell@X×1.005 → buy@X×0.9975 → back): distance 0.75% → net **+0.55%** после fees

**Таймер и рестарт:**
- Сравнение: `Date.now() - this.lastAutoSpacingRun >= autoSpacingIntervalMin * 60_000` [combo-manager.ts:347-348](src/strategies/combo-manager.ts#L347-L348)
- `lastAutoSpacingRun` — **приватное поле в памяти** `ComboManager`, в `bot-state.json` НЕ сохраняется
- При рестарте `lastAutoSpacingRun = 0` → условие `=== 0` → **на первом же тике после старта бот запускает `runAutoSpacing()` немедленно**, независимо от того, сколько прошло до рестарта
- Персистенция результатов — через `config.jsonc` (режим `auto`). При старте grid читает per-pair spacing уже с последними посчитанными значениями

**Как спейсинг реально попадает в grid** (`getSpacing()` [grid.ts:110-123](src/strategies/grid.ts#L110-L123)):
- Если `priority === "auto"` и есть запись в `autoSpacingMap[symbol]` — вернуть её
- Иначе — per-pair override в `config.pairs[].gridSpacingPercent` / `gridSpacingSellPercent`
- Иначе — глобальный `config.grid.gridSpacingPercent` / `gridSpacingSellPercent`

Это значит: в режиме `"auto"` источник правды для рабочего spacing — память (`autoSpacingMap`), а `config.jsonc` — только резервная копия для рестарта. Обычный auto-rebalance (drift >2%) тоже использует этот же `getSpacing()` → новые значения применяются к любой ветке пересборки, не только к force-rebalance.

**Per-pair spacing override:** каждая пара может иметь свой `gridSpacingPercent` / `gridSpacingSellPercent` в секции `pairs` конфига. Если не указан — берётся глобальный из секции `grid`. В режиме `"auto"` этот слой перекрывается `autoSpacingMap`.

**No-Loss Sell Protection — 6 механизмов:**

Общая константа: `breakEvenMult = 1 + minSellProfitPercent/100` (1.005 при `minSellProfitPercent=0.5`). `minSellPrice = avgEntry × breakEvenMult` — безубыточная цена, ниже которой sell-ордера не выставляются (кроме halving, ограниченного сохранённым `oldBreakEven`).

Все sell-создающие пути (initial grid sell, counter-sell flip, orphan-sell) **единообразно**: если рассчитанная цена < minSellPrice — **поднимают цену ордера до minSellPrice** и всё равно ставят ордер. Параметр `maxSellLossPercent` удалён как мёртвый: защита всегда жёсткая — «не ниже break-even».

1. **Grid Sell Guard** ([grid.ts:534-553](src/strategies/grid.ts#L534-L553), при placeGridOrders): если `level.price < minSellPrice` → `level.price` повышается до `minSellPrice`, лог `Grid sell raised to break-even: X → Y`. Anchors (`oldBreakEven`, `originalPlannedSellPrice`) сохраняются в level — halving при последующем split rebalance DOWN работает и с initial grid sell.

2. **Counter-Sell Guard** ([grid.ts:780-797](src/strategies/grid.ts#L780-L797), при flip buy→counter-sell): если `counterPrice < minSellPrice` → `counterPrice` повышается до `minSellPrice`, лог `Counter-sell raised to break-even: X → Y`. Anchor `originalPlannedSellPrice` сохраняет ПЕРВОНАЧАЛЬНУЮ (spacing-based) цену до подъёма — halving имеет осмысленный «старт сползания».

3. **Split Rebalance DOWN** (`initGrid`): при drift вниз >2% от center — отменяются ТОЛЬКО buy-ордера (`cancelBuySide`), sell-ы остаются на прибыльных уровнях. Новые buy создаются вокруг новой цены. При drift UP — full rebuild (`cancelAllPreserveCounterSellMeta`).

4. **Counter-Sell Midpoint Halving** (runtime trailing после split rebalance DOWN). Metadata заполняется в 2 этапа:
   - **Phase 1 — anchors** (при flip buy→counter-sell и при создании initial grid sell / orphan-sell): ставятся `oldBreakEven` (безубыточная цена для этой покупки) и `originalPlannedSellPrice` (изначально запланированная цена до любого подъёма до break-even). Живут весь жизненный цикл ордера.
   - **Phase 2 — runtime** (`initCounterSellTrailing`, вызывается только из split rebalance DOWN): если `level.price > virtualNewSellPrice = currentPrice × (1 + sellSpacing/100)` — заполняются `virtualNewSellPrice` (цель halving) + `nextStepAt = Date.now() + counterSellTrailStepHours × 3600000`. Шаг 2 делается сразу:
     - Если `virtualNewSellPrice < oldBreakEven` (защита включена): `newPrice = max(oldBreakEven, midpoint(originalPlannedSellPrice, virtualNewSellPrice))` с ceil-округлением → лог `protected halving`. **Это единственный шаг, где oldBreakEven действует как floor.**
     - Иначе (`virtualNewSellPrice ≥ oldBreakEven`): сразу `newPrice = virtualNewSellPrice`, runtime-поля обнуляются → лог `direct`
   - **Последующие шаги** (Step 3+, на каждом тике): если `Date.now() >= nextStepAt` → `newPrice = midpoint(level.price, virtualNewSellPrice)` **без floor oldBreakEven**, `nextStepAt += stepMs`. Бинарный спуск сходится к `virtualNewSellPrice` (когда `|level.price - v|/v ≤ 0.05` — прыгаем сразу на цель и завершаем). **По дизайну может уводить цену ниже `oldBreakEven`** — это часть halving-стратегии: если рынок не возвращается, ордер в итоге должен всё-таки закрыться у цели, даже в убыток. Floor `oldBreakEven` защищает только Step 2 (смягчение первого падения); последующие шаги — добровольное сползание.
   - **Halving-таймер переживает рестарт** — `nextStepAt` хранится в `bot-state.json` как абсолютный Unix-timestamp. После рестарта сравнение `Date.now() >= nextStepAt` засчитывает downtime: если таймер истёк во время простоя — шаг halving делается на первом же тике.
   - **Lifecycle runtime-полей через rebalance:**

     | Событие | `oldBreakEven` | `originalPlannedSellPrice` | `virtualNewSellPrice` | `nextStepAt` |
     |---------|----------------|---------------------------|----------------------|--------------|
     | **rebalance DOWN** (split) | сохраняется | сохраняется | **устанавливается** (`currentPrice × (1 + sellSpacing/100)`) | **устанавливается** (`Date.now() + counterSellTrailStepHours × 3600s`) |
     | **rebalance UP** | сохраняется | сохраняется | **сбрасывается** (`undefined`) | **сбрасывается** (`undefined`) |
     | **Force-rebalance** | сохраняется | сохраняется | **сбрасывается** (`undefined`) | **сбрасывается** (`undefined`) |

     При rebalance UP (`cancelAllPreserveCounterSellMeta`) runtime-поля halving (`virtualNewSellPrice`, `nextStepAt`) **обнуляются**. Старый таймер не переживает rebalance UP. Статические anchors (`oldBreakEven`, `originalPlannedSellPrice`) при этом сохраняются. Следующий rebalance DOWN вызовет `initCounterSellTrailing` заново — таймер стартует с `Date.now()`, а не со старого значения. Сравнения "успел ли истечь старый таймер" не происходит.
   - **Force-rebalance** (auto-spacing / `/regrid` / `/unfreezebuy` / `/unsellgrid`) ведёт себя аналогично rebalance UP: `cancelAllPreserveCounterSellMeta` обнуляет runtime, сохраняет anchors. Halving запустится при следующем split rebalance DOWN.
   - **counterSellTrailStepHours:** `>0` — halving шагами; `0` — снап сразу на virtualNewSellPrice без шагов; `<0` — trailing полностью выключен.

5. **Orphan-sell** (непокрытая free-balance позиция, [grid.ts:987-1020](src/strategies/grid.ts#L987-L1020)) — floor по абсолютной ЦЕНЕ (не по проценту):
   ```
   targetMarkupPct = sellSpacingPct × priceStep                          // priceStep = 1, 2, 3 ...
   pricePrediction = ticker.last × (1 + targetMarkupPct / 100)
   breakEvenPrice  = avgEntry × (1 + minSellProfitPercent / 100)
   sellPrice       = max(pricePrediction, breakEvenPrice)                // FLOOR на ЦЕНЕ
   ```
   `priceStep` начинается с 1, увеличивается на +1 при каждом новом orphan-sell в тике (ladder размещения до `orphanSellMaxPerTick`) или при коллизии с существующим sell. При срабатывании FLOOR пишется INFO-лог `orphan-sell floor activated: pricePrediction=X < breakEvenPrice=Y ...`. Anchors сохраняются в новый level (`oldBreakEven = breakEvenPrice`, `originalPlannedSellPrice = pricePrediction`) — halving работает и с orphan-sell единообразно.

6. **SL/TP/Trailing SL** (аварийная продажа): market sell через `executeRiskSell`, guard НЕ применяется. Текущая конфигурация: `stopLossPercent: 20%`, `trailingSLPercent: 999` (выключен). SL может продать в убыток — это явная защита от катастрофического падения.

**Итог:** при **первичном размещении** (initial grid sell, counter-sell flip, orphan-sell) грид никогда не ставит лимитный sell ниже `avgEntryPrice × (1 + minSellProfitPercent/100)`. Продажа в убыток возможна через:
- **Halving Step 3+** — бинарный спуск counter-sell к `virtualNewSellPrice` при split rebalance DOWN, по дизайну может уйти ниже `oldBreakEven` если рынок не возвращается (контролируемое сползание).
- **Stop-Loss** при -20% от entry — market sell, глобальная защита от катастрофического падения.

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

# Или напрямую (foreground, stdout в консоль)
npx ts-node src/index.ts

# Фоновый запуск (правильный способ — stdout в /dev/null, логи ведёт Winston)
(npx ts-node src/index.ts > /dev/null 2>&1 &)

# Мониторинг (использовать glob — после ротации активный файл не всегда bot.log)
tail -f bot*.log
```

⚠️ **НЕ** запускать с `>> bot.log 2>&1` — shell-redirect дублирует всё в `bot.log` в обход Winston'овской ротации, `bot.log` растёт бесконечно, и появляются дубли логов между `bot.log` и `bot1.log`. Winston сам управляет файлами через File transport — stdout надо отправлять в `/dev/null`.

### Остановка

```bash
taskkill //F //IM node.exe   # Windows (через git bash)
rm -f bot.lock
```

Ордера на Bybit при остановке **не отменяются** — продолжают стоять. Бот подхватит их на следующем запуске через sync.ts.

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

- **bot.log** — полный лог (ротация Winston'ом: 10MB × maxFiles=5)
- **errors.log** — только ошибки (5MB × maxFiles=3)
- **console** — всё в реальном времени (не редиректить в файл — сломает ротацию)

Summary каждые 10 тиков: капитал, PnL, drawdown, trades, positions, market panic/BTC watchdog.

### Ротация логов

Winston автоматически ротирует файлы при превышении `maxsize`:
1. `bot.log` достигает 10MB → **замораживается** как архив (не пишется дальше)
2. Новые записи идут в `bot1.log` (создаётся автоматически)
3. Когда `bot1.log` достигает 10MB → замораживается, новые в `bot2.log`, и так далее
4. После `maxFiles=5` файлов самый старый (`bot5.log` или близкий) **удаляется** — на диске не больше 5 файлов.

**Важно для мониторинга:**
- Не диагностировать «hang» по свежести `bot.log` — может быть просто заморожен после ротации. Правильная проверка живости: `mtime bot-state.json` (обновляется каждый тик) **или** `grep "BOT SUMMARY ===" bot*.log | tail -1` (через glob, захватывает все файлы).
- Не запускать бот с shell-redirect `>> bot.log` — сломает ротацию Winston (будут дубликаты + bot.log расти бесконечно). Правильный запуск: `(npx ts-node src/index.ts > /dev/null 2>&1 &)` — Winston сам ведёт файлы.

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

**Raise-to-break-even Sell Guard:**
- Во всех путях создания sell-ордеров (initial grid sell, counter-sell flip, orphan-sell): если расчётная цена ниже `avgEntry × (1 + minSellProfitPercent/100)` → цена ордера **поднимается** до этой безубыточной, ордер всё равно ставится.
- Все sell-уровни сохраняют anchors `oldBreakEven` + `originalPlannedSellPrice` — используются halving-механизмом при последующем split rebalance DOWN.
- Orphan-sell floor реализован через `max(pricePrediction, breakEvenPrice)` по абсолютной цене, не по проценту.
- Параметр `maxSellLossPercent` удалён как мёртвый (защита всегда жёсткая).

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

### v2.6.0 (2026-04-19)

Fair-share USDT budget, расширенный BOT SUMMARY, дедуп/унификация логов, HALT_HINT во всех halt-событиях.

**Fair-share USDT budget per pair** ([grid.ts:400-430](src/strategies/grid.ts#L400-L430)):
- Раньше: параллельная обработка пар позволяла первой паре в батче забрать весь свободный USDT, остальные получали `low USDT`
- Теперь каждой паре выдаётся справедливая доля USDT на buy-ы:
  ```
  pool = freeUSDT + USDT locked in all pairs' buy orders
  fairShare = (pair.allocationPercent / totalActiveAlloc) × pool
  budget = min(freeUSDT, max(0, fairShare − thisPairLockedInBuys))
  ```
- Frozen/sellgrid/deleted пары исключены из `totalActiveAlloc`
- Counter-buys, orphan-sells, trailing — используют `freeUSDT` напрямую (часть активного цикла, без квот)
- Внутри бюджета пары размещается столько ордеров, сколько поместится

**Разделение skip reasons на buy/sell** в BOT SUMMARY ([combo-manager.ts:1420](src/strategies/combo-manager.ts#L1420)):
- Две независимые колонки: `skip buy: ...!` и `skip sell: ...!`
- Могут быть обе одновременно: `| skip buy: EMA bearish! | skip sell: low AAVE!`
- Grid.getBuySkipReason() / getSellSkipReason() — новые геттеры для ComboManager

**Возможные skip причины:**

| Причина | Сторона | Когда срабатывает |
|---|---|---|
| `EMA bearish` | buy | `useEmaFilter=true` + `emaFast < emaSlow` |
| `overbought` | buy | RSI > `rsiOverboughtThreshold` |
| `buy frozen` | buy | пара в `/freezebuy` или `sellgrid` |
| `BTC watchdog occured` | buy | BTC упал >3% за час |
| `low USDT (pair budget)` | buy | исчерпан лимит пары |
| `max orders` | buy/sell | достигнут `gridLevels + GRID_SELL_LEVELS + 4` (при текущем config 5+20+4=29) |
| `budget too small` | buy/sell | orderSize < minAmount биржи |
| `below minCost` | buy/sell | стоимость < minCost биржи |
| `insufficient balance` | buy/sell | API-ошибка при размещении |
| `low <BASE>` (например `low AAVE`) | sell | недостаточно крипты для sell |

**BOT SUMMARY — изменения per-pair строки:**
- **EMA колонка** теперь показывает **persistent trend** (`bull/bear/flat` по `emaFast vs emaSlow`), а не одноразовое `emaCrossover` событие. Раньше можно было увидеть противоречие `EMA neut + skip: EMA bearish!` — теперь одно и то же состояние в обеих местах.
- **Счётчики SL/TSL/TP всегда показаны** с пробелом: `SL 0x | TSL 1x | TP 0x` (раньше были `SL:1x`, при 0 не показывались вообще)
- **Skip маркер** в конце строки: `skip buy: EMA bearish!` (восклицание в конце, чтобы обращать внимание)

**Унифицированный формат логов** ([grid.ts](src/strategies/grid.ts), [exchange.ts](src/exchange.ts), [combo-manager.ts](src/strategies/combo-manager.ts)):

```
[grid]   SUI/USDT    buy  filled   6.09 @ 0.9581
[grid]   SUI/USDT    sell filled   6.08 @ 1.0999
[grid]   SOL/USDT    buy  placed   0.0673 @ 88.43    (counter-order)
[grid]   AAVE/USDT   sell placed   0.0564 @ 105.29   (counter-order)
[grid]   SUI/USDT    sell placed   6.08 @ 0.9921     (orphan-sell)
[grid]   RENDER/USDT sell placed   3.01 @ 1.920      (sellgrid-ladder)
[grid]   SUI/USDT    buy  placed   6.09 @ 0.9581     (grid-init)
[grid]   SUI/USDT    buy  reduced  6.09 → 4.50       (73% of target, budget=$4.32)
[grid]   DOT/USDT    sell trailed  1.400 → 1.365     (counter-sell, protected halving, goal=1.318)
[grid]   DOT/USDT    sell trailed  1.329 → 1.324     (counter-sell, halving, goal=1.318)
[grid]   DOT/USDT    sell trailed  1.329 → 1.318     (counter-sell, halving done)
[grid]   DOT/USDT    sell trailed  1.329 → 1.318     (counter-sell, direct)
[grid]   DOT/USDT    EMA crossover: bearish (buys blocked by filter)
[dca]    AAVE/USDT   buy  market   0.0565
[meta]   SUI/USDT    buy  market   5.0
[meta]   SUI/USDT    sell market   6.08
[risk]   SUI/USDT    sell market   6.08              (stop-loss)
[risk]   SUI/USDT    sell market   6.08              (take-profit)
[risk]   SUI/USDT    sell market   6.08              (trailing-stop-loss)
[risk]   SUI/USDT    sell market   6.08              (portfolio take-profit)
[manual] SUI/USDT    buy  market   10.0
[manual] SUI/USDT    sell market   6.08              (sell-all)
Grid skip SUI/USDT: buy: EMA bearish, max orders | sell: low SUI
Grid orders resumed for SUI/USDT — all levels placed
```

**Дедупликация логов:**
- `EMA crossover` — логируется **только при смене** состояния `bearish↔bullish↔neutral` (раньше спамил каждый тик)
- `Grid skip` — логируется **каждый тик** (раньше был дедуп, но пользователь хотел видеть текущую причину всегда)

**HALT_HINT во всех halt-событиях:**
- Все лог-строки и Telegram-алерты о halt содержат подсказку `Для возобновления: /run или halted→false в bot-state.json`
- Места: MAX DRAWDOWN, PORTFOLIO TAKE-PROFIT, per-pair halt (3× SL), cooldown=0 halt, `/stop`, `/sellall`, `/cancelorders`

**Переименования:**
- `market protection` → `BTC watchdog occured`
- `pair USDT budget exhausted` → `low USDT (pair budget)`

### v2.7.0 (2026-04-26)

Усиление инварианта sell-buy gap, ослабление EMA-фильтра, привязка `FEE_ROUND_TRIP_PCT` к `minSellProfitPercent`, перебалансировка под bearish-фазу.

**Закрытие инварианта `sell ≥ buy + minSellProfitPercent` после hybrid floor** ([combo-manager.ts:189-200](src/strategies/combo-manager.ts#L189-L200)):
- Раньше: после `safetyMultiplier` и независимого hybrid floor разница `sell − buy` могла оказаться меньше `FEE_ROUND_TRIP_PCT`. Например `weighted buy=0.20 / sell=0.50` (диф 0.30) → после safety 0.93× → `0.186/0.465` → после floor `buy=0.25, sell=0.50` → диф 0.25, что меньше break-even gap.
- Теперь после floor добавлен явный `sell = volRound(Math.max(sellAfterFloor, buy + minSellProfitPct), 2)` — full-cycle profit (`sell→buy→back`) гарантированно ≥ `minSellProfitPercent`.
- Эффект на конфиг: после первого auto-spacing цикла все пары получили `sell - buy = 0.75` ровно (см. свежие значения для DOT `0.85/1.60`, SOL `0.59/1.34`, AAVE `1.22/1.97` — везде разница ровно `minSellProfitPercent`).

**Связь `FEE_ROUND_TRIP_PCT` ↔ `minSellProfitPercent`** ([volatility.ts:67-79](src/volatility.ts#L67-L79), [analyze-volatility.ts:55-66](analyze-volatility.ts#L55-L66)):
- В боте `combo-manager.runAutoSpacing()` передаёт `config.grid.minSellProfitPercent` как `feeRoundTripPct` в `analyzeAllSymbols()` — раньше связь существовала, но не была явной из имени константы.
- Default `FEE_ROUND_TRIP_PCT` поднят с `0.3` до `0.5` (соответствует «стандартному» break-even); комментарий с явной формулой связи добавлен.
- Standalone-скрипт `analyze-volatility.ts` теперь читает `config.grid.minSellProfitPercent` через минимальный JSON-парсер (стрипает `// ...` и `/* ... */` комментарии) и передаёт его явно — синхронизация со spacing'ами боевого бота.
- Шапка `volatility.ts:47-56` обновлена: устаревший docstring `floor: buy >= 0.3%, sell >= buy + 0.3%` заменён на актуальный hybrid floor + предупреждение про инвариант после floor.

**EMA-фильтр: тройное условие вместо одиночного** ([grid.ts:204-214](src/strategies/grid.ts#L204-L214))

**Раньше:** `useEmaFilter=true && emaFast < emaSlow` → жёсткий блок buy. На длинном bearish-тренде grid-buy полностью отключался неделями, capital exhausted.

**Теперь:** блок только при `EMA bearish AND RSI ≥ 45 AND цена ≥ BB middle`. На bearish-тренде разрешён buy если есть хотя бы один сигнал отскока: `RSI < 45` ИЛИ цена в нижней половине BB.

#### Что такое `emaFast` и `emaSlow`

**EMA (Exponential Moving Average)** — экспоненциальное скользящее среднее. В отличие от обычного среднего арифметического, EMA даёт **больший вес недавним свечам** и меньший — старым. Формула рекуррентная ([indicators.ts:49-70](src/indicators.ts#L49-L70)):

```
α = 2 / (period + 1)
EMA[i] = price[i] × α + EMA[i-1] × (1 − α)
```

Где:
- `period` — длина окна в свечах (`emaFastPeriod=9` или `emaSlowPeriod=21`)
- `α` — коэффициент сглаживания. Для period=9: `α=0.20` (новая свеча даёт 20% веса, старое EMA-значение 80%). Для period=21: `α≈0.091` (новая свеча 9%, старое 91%).
- `price[i]` — close i-ой свечи

Чем меньше `period`, тем «быстрее» EMA реагирует на изменение цены — отсюда названия **fast** (короткий период) и **slow** (длинный).

**Как используется в проекте:**

Одна EMA сама по себе показывает «среднюю цену с приоритетом свежих данных», но не даёт чёткого сигнала о тренде. Поэтому в техническом анализе используют **пару EMA** с разными периодами:

| Линия | Период | Время на 5m-свечах | Что показывает |
|---|---|---|---|
| `emaFast` | 9 свечей | **45 мин** | краткосрочная цена-tracker, реагирует быстро |
| `emaSlow` | 21 свеча | **105 мин (~1ч 45мин)** | средне-краткосрочный тренд, инертная база |

**Сигналы пересечения** (вычисляются в [indicators.ts:181-189](src/indicators.ts#L181-L189) сравнением последних двух значений `emaFastArr` и `emaSlowArr`):

- **Bullish (golden cross):** `emaFast > emaSlow` — fast пересекла slow вверх. Цена за последний ~час растёт быстрее, чем за последние ~2 часа → восходящее движение.
- **Bearish (death cross):** `emaFast < emaSlow` — fast пересекла slow вниз. Цена за последний ~час падает быстрее, чем за последние ~2 часа → нисходящее движение.
- **Neutral:** `emaFast ≈ emaSlow` (разница меньше эпсилона) — нет выраженного тренда, рынок боковой.

В BOT SUMMARY это отображается в колонке `EMA`:
- `bull` — `emaFast > emaSlow` (golden cross активен)
- `bear` — `emaFast < emaSlow` (death cross активен)
- `flat` — близко к равенству, тренда нет

**Где вычисляется:** функции `calcEMA` и `lastEMA` в [indicators.ts:46-75](src/indicators.ts#L46-L75). Используются в `computeIndicators` ([indicators.ts:175-178](src/indicators.ts#L175-L178)) поверх 100 свечей `5m`, которые `processPair` фетчит каждый тик ([combo-manager.ts:604](src/strategies/combo-manager.ts#L604)).

**Почему пара 9/21 — классика:**

Соотношение `9:21 ≈ 1:2.3` — fast в ~2.3 раза быстрее slow. Этого достаточно чтобы их пересечение было «заметным событием» (не дёрганьем в шуме), но не настолько, чтобы сигнал приходил с большой задержкой. Альтернативная классика — MACD-пара `12/26` (соотношение `1:2.17`), но она ещё медленнее и используется обычно на дневных свечах.

**Зачем нужны EMA в боте, если уже есть RSI и BB:**

Каждый из трёх индикаторов меряет **свой аспект цены**:

| Индикатор | Что меряет | Окно |
|---|---|---|
| **RSI** | импульс (сила покупателей vs продавцов в окне) | 14 свечей = 70 мин |
| **EMA** (fast vs slow) | направление тренда (вверх/вниз/боковик) | 9–21 свечей = 45–105 мин |
| **Bollinger Bands** | волатильность + позиция цены относительно средней | 20 свечей = 100 мин |

EMA-фильтр в `isBuyAllowed()` использует именно тренд-компонент — отвечает на вопрос «куда сейчас идёт цена в среднесрочном горизонте». RSI и BB добавляются как разрядка для случаев, когда тренд медвежий, но локально есть признаки отскока.

#### Канонические зоны RSI (на 14 свечах × 5m = 70 минут истории)

```
0────────30─────────45────50──────────70──────75────────100
oversold │ weak-bear │ mid │ weak-bull │ over │ overbought
                                              │
                                              ↑
                                              блок при любой
                                              EMA/BB (rsiOverboughtThreshold)
```

**Семантика зон в контексте grid-buy:**

| RSI | Канон | Что значит для buy |
|---|---|---|
| 0–30 | **oversold** | сильная перепроданность; классический сигнал входа (отскок впереди с высокой вероятностью). Buy разрешён всегда. |
| 30–45 | weak-bear | давление продаж ослабло; рынок в нижней половине, восстановление вероятнее продолжения. Buy разрешён, EMA-фильтр **пропускает** даже при `EMA bearish` (потому что RSI<45 = «есть сигнал отскока»). |
| 45–50 | mid (нижняя нейтраль) | равновесие со склонением вниз. На EMA bull — buy разрешён, на EMA bear — **смотрится BB**: если цена ниже middle (bounce-зона) — пропуск, иначе блок. |
| 50–70 | weak-bull | рынок над серединой; покупатели активны, но не доминируют. На EMA bull — buy разрешён, на EMA bear — тот же BB-критерий (нужна цена ниже middle). |
| 70–75 | over (мягкая перекупленность) | покупатели выдыхаются, но ещё не переразогрели. **Buy разрешён** — раньше `rsiOverboughtThreshold=70` блочил эту зону, сейчас 75 даёт в неё доступ. На отскоках после просадки RSI часто проходит 70→75 за час, мы ловим этот хвост. |
| 75–100 | **overbought** | риск разворота вниз очень высокий. Buy блокируется **независимо** от EMA и BB через `rsiOverboughtThreshold=75`. |

#### Как взаимодействуют EMA-фильтр и RSI-overbought

Это **два независимых фильтра**, оба применяются к одному buy-action:

1. **`rsiOverboughtThreshold=75`** ([grid.ts:198-202](src/strategies/grid.ts#L198-L202)) — отрезает верхнюю зону RSI 75–100. Жёсткий, без условий — независимо от EMA/BB.
2. **EMA-фильтр** ([grid.ts:204-214](src/strategies/grid.ts#L204-L214)) — отрезает зону RSI 45–75 **только если** EMA bearish И цена выше BB middle.

**Нейтральная торговая зона: RSI 45–75 при `EMA bull` (любой BB) ИЛИ при `EMA bear` если цена ниже BB middle.** Это «работающая» половина пространства — где grid-buy свободно ставится. Внутри неё дальше уже работают `low USDT (pair budget)`, `BTC watchdog`, `buy frozen` и другие фильтры из второй очереди.

#### Симметрия порогов

Логика построена симметрично:

```
          вход разрешён
         ←━━━━━━━━━━━━━→
  block  ←━━━━━━━━━━━━━━━━━━━━━━━→  block
 (EMA b)  RSI 45 ──── RSI 75       (RSI overbought)
         цена<middle   цена>middle
         → пропуск     → блок
```

- **Нижний порог `45`** (EMA-разрядка) — где RSI «достаточно низкий чтобы лезть на bearish тренде». Не классические 30 — те слишком жёсткие, появляются редко и часто после полной капитуляции, когда отскок уже состоялся.
- **Верхний порог `75`** (overbought) — где RSI «достаточно высокий чтобы НЕ лезть». Не классические 70 — те ловят слишком много нормальных отскоков после просадки.
- Полоса 45–75 = «торговая зона», шириной 30 пунктов RSI. Внутри неё grid-buy работает свободно (если другие условия — budget, BTC, freeze — не блокируют).

#### Двухосевая логика для EMA-фильтра

Когда `EMA bearish`, фильтр требует **хотя бы один** из двух независимых сигналов отскока:

| RSI | BB position | Решение |
|---|---|---|
| < 45 | любая | ✅ пытаемся купить (RSI oversold/weak-bear) |
| ≥ 45 | `below_middle` или `below_lower` | ✅ пытаемся купить (цена в нижней половине BB) |
| ≥ 45 | `above_middle` или `above_upper` | ❌ не ставим новых buy-ордеров (нет сигнала отскока) |

Идея «двухосевости»: RSI меряет **импульс** (давление покупателей vs продавцов на коротком окне), BB меряет **позицию** (где цена относительно средней + волатильности). Один сигнал может быть ложным, два независимых — гораздо реже одновременно. Если хоть один из них «зелёный» — фильтр пропускает.

#### Что показывает skip reason в BOT SUMMARY

При срабатывании EMA-блока в колонке `buy:` отображается:

```
buy:EMA bearish + RSI 52.2 >= 45 + price >= BB middle sell:low SOL
```

Все три части блокирующего условия видны в строке: тренд по EMA, конкретное значение RSI с порогом, позиция цены по BB. Это удобно для отладки — сразу понятно которое из условий «выстрелило» (для пропуска нужно отрицание любого).

#### Edge case: периоды EMA на 5m-свечах

EMA `9/21` на 5-минутных свечах — это ~45мин fast / ~105мин slow. Чувствительность достаточна чтобы поймать локальный разворот тренда за несколько часов, но не настолько, чтобы дёргаться на каждой 15-минутной волне. Раньше было `7/15` (~35/75 мин) — сократили чтобы «быстрее разблокировать buy», но ценой большего количества ложных flip'ов. После добавления RSI/BB-разрядки роль «быстрой разблокировки» взяла на себя именно она, и EMA вернули к классике `9/21` (откат после v2.7.0, дата 2026-04-26).

**Изменения параметров `config.jsonc`:**

| Параметр | Было | Стало | Эффект |
|---|---:|---:|---|
| `grid.minSellProfitPercent` | 0.5 | **0.75** | Counter-sell markup ≥ 0.75% от avgEntry → 0.55% net на оборот после fees. **Симметрично** становится floor для gap `sell-buy` в auto-spacing. |
| `grid.rsiOverboughtThreshold` | 70 | **75** | На отскоках RSI часто 70-75, мягче overbought-блок |
| `grid.qtySigmas` | 1 | **2** | Классика 2σ-фильтра выбросов (отсекает явные flash-crashes), не 16% обычных свечей |
| `grid.autoSpacingSafetyMarginPercent` | 7 | **0** | Полное доверие статистике; раньше сужал spacing на 7% — ловил шум на спокойном рынке |
| `allocationPercentMode` | "auto" | **"config"** | Фиксация ручных аллокаций; `rewritePairAllocations` больше не переписывает их при add/delete пар |

**Перебалансировка аллокаций под bearish-фазу** (сумма 95%, 5% USDT-резерв):

| Пара | PnL | было | стало | Логика |
|---|---:|---:|---:|---|
| DOT/USDT | +10.5% | 14% | **18%** | работает в плюс — больше budget |
| SUI/USDT | −8.8% | 14% | **16%** | умеренный минус |
| ADA/USDT | −23.9% | 14% | **14%** | без изменений |
| SOL/USDT | −29.3% | 14% | **13%** | плохой, чуть уменьшить |
| NEAR/USDT | −39.2% | 14% | **12%** | sellgrid, не подливать |
| RENDER/USDT | −37.8% | 14% | **12%** | sellgrid, не подливать |
| AAVE/USDT | −52.2% | 14% | **10%** | худший, минимизация |
| XRP/USDT | deleted | 0% | 0% | — |

**Реальные spacing'и после первого auto-spacing с новыми параметрами** (`qtySigmas=2 + safetyMargin=0 + sell ≥ buy + 0.75`):

```
DOT/USDT:    0.85% / 1.60%   (было 0.71 / 1.14)
NEAR/USDT:   0.78% / 1.53%   (было 0.65 / 1.08, sellgrid)
ADA/USDT:    0.77% / 1.52%   (было 0.64 / 1.06)
SUI/USDT:    0.79% / 1.54%   (было 0.66 / 1.09)
SOL/USDT:    0.59% / 1.34%   (было 0.48 / 0.91)
AAVE/USDT:   1.22% / 1.97%   (было 0.98 / 1.41, sellgrid)
RENDER/USDT: 1.00% / 1.75%   (было 0.83 / 1.26, sellgrid)
XRP/USDT:    0.50% / 1.25%   (deleted, считается косметически)
```

Все `sell - buy` ровно `0.75%` — инвариант доминирует над per-pair P70(ranges) при текущей низкой волатильности. На сильной волатильности `recSellSpacing = max(P70, recBuy + 0.75)` будет давать значения шире 0.75, и инвариант перестанет быть «доминантой».

## Справочник текстовок (формат логов и сообщений)

### Grid события ([grid.ts](src/strategies/grid.ts) / [exchange.ts](src/exchange.ts))

```
[grid]   SUI/USDT    buy  filled   6.09 @ 0.9581
[grid]   SUI/USDT    sell filled   6.08 @ 1.0999
[grid]   SOL/USDT    buy  placed   0.0673 @ 88.43    (counter-order)
[grid]   AAVE/USDT   sell placed   0.0564 @ 105.29   (counter-order)
[grid]   SUI/USDT    sell placed   6.08 @ 0.9921     (orphan-sell)
[grid]   RENDER/USDT sell placed   3.01 @ 1.920      (sellgrid-ladder)
[grid]   SUI/USDT    buy  placed   6.09 @ 0.9581     (grid-init)
[grid]   SUI/USDT    buy  reduced  6.09 → 4.50       (73% of target, budget=$4.32)
```

### Counter-sell trailing (4 варианта)

```
[grid]   DOT/USDT    sell trailed  1.400 → 1.365     (counter-sell, protected halving, goal=1.318)
[grid]   DOT/USDT    sell trailed  1.329 → 1.324     (counter-sell, halving, goal=1.318)
[grid]   DOT/USDT    sell trailed  1.329 → 1.318     (counter-sell, halving done)
[grid]   DOT/USDT    sell trailed  1.329 → 1.318     (counter-sell, direct)
```

- `protected halving` — первый шаг (step 2) с защитой `oldBreakEven`
- `halving, goal=X` — промежуточные midpoint-шаги (step 4) к целевой цене X
- `halving done` — финальный шаг, достигли `virtualNewSellPrice`
- `direct` — шаг 3, целевая цена выше `oldBreakEven`, сразу на цель

### EMA crossover (только при смене тренда)

```
[grid]   DOT/USDT    EMA crossover: bearish (buys blocked by filter)
[grid]   DOT/USDT    EMA crossover: bullish
```

Логируется только при переходе `bearish↔bullish↔neutral` (дедуп по `lastEmaCrossover`).

### Market orders ([exchange.ts](src/exchange.ts))

```
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

Префикс = стратегия (`dca`/`meta`/`risk`/`manual`), label в скобках = подпричина для risk/manual.

### Grid skip (каждый тик, раздельно buy/sell)

```
Grid skip SUI/USDT: buy: EMA bearish, max orders | sell: low SUI
Grid orders resumed for SUI/USDT — all levels placed
```

### Все возможные skip причины

| Причина | Сторона | Когда срабатывает |
|---|---|---|
| `EMA bearish` | buy | `useEmaFilter=true` + `emaFast < emaSlow` |
| `overbought` | buy | RSI > `rsiOverboughtThreshold` |
| `buy frozen` | buy | пара в `/freezebuy` или `sellgrid` |
| `BTC watchdog occured` | buy | BTC упал >3% за час |
| `low USDT (pair budget)` | buy | исчерпан per-pair лимит бюджета |
| `max orders` | buy/sell | достигнут `gridLevels + GRID_SELL_LEVELS + 4` открытых ордеров |
| `budget too small` | buy/sell | orderSize < minAmount биржи |
| `below minCost` | buy/sell | стоимость < minCost биржи |
| `insufficient balance` | buy/sell | API-ошибка при размещении |
| `low <BASE>` (например `low AAVE`) | sell | недостаточно крипты для sell |

### BOT SUMMARY — per-pair строка

```
AAVE/USDT | PnL -11.90 (-30.7%) | Spent 38.77 | Earned 26.90 | Fees 0.027 | RSI 31.4 | EMA bear | BB oversold | 0B | 2S [12$] | SL 0x | TSL 1x | TP 0x | skip buy: EMA bearish, low USDT (pair budget)! | skip sell: low AAVE!
```

Колонки:
- **EMA**: `bull/bear/flat` — persistent тренд (`emaFast vs emaSlow`), совпадает с логикой фильтра
- **BB**: `oversold/bear/bull/overbought` — позиция цены относительно Bollinger bands
- **B/S**: активные buy/sell ордера на бирже (`8B [50$]`, `11S [76$]`) или `0B`/`0S`/`3Pend`
- **SL/TSL/TP Nx**: счётчики сработавших Stop-Loss / Trailing SL / Take-Profit (всегда показаны с пробелом, включая 0x)
- **HALTED:reason** или **COOL:Nmin** — если пара остановлена или в cooldown
- **skip buy: ...!** / **skip sell: ...!** — причины пропуска размещения (с `!` в конце)

### Halt-события (лог + Telegram)

Все halt-события включают подсказку `Для возобновления: /run или halted→false в bot-state.json`:

```
🚨 MAX DRAWDOWN 15.3%  Peak: 314.91 → 266.79 USDT  Bot HALTED!
🎉 PORTFOLIO TAKE-PROFIT! Start: 300.00 → 600.00 USDT (+100.0%)  All sold. Bot halted.
🛑 AAVE/USDT HALTED  3x SL подряд — пара остановлена.
🛑 AAVE/USDT HALTED  SL сработал, cooldown=0 — пара остановлена навсегда.
🔴 STOP-LOSS AAVE/USDT  Entry: 104.13 → 83.31  PnL: -20.0%
🟡 TRAILING SL AAVE/USDT  Entry: 104.13 | Peak: 110.00 → 104.50  Drop: -5.0%  PnL: +0.4%
🟢 TAKE-PROFIT AAVE/USDT  Entry: 104.13 → 116.62  PnL: +12.0%
```

### Auto-spacing (выровнен через `.toFixed(2)`)

```
  DOT/USDT:    auto=1.38%/1.88% cfg=1.38%/1.88% regime=norm [AUTO]
  NEAR/USDT:   auto=1.19%/1.69% cfg=1.19%/1.69% regime=norm [AUTO]
  ADA/USDT:    auto=1.02%/1.52% cfg=1.02%/1.52% regime=norm [AUTO]
  AAVE/USDT:   auto=1.45%/1.95% cfg=1.45%/1.95% regime=high [AUTO]
  RENDER/USDT: auto=1.32%/1.82% cfg=1.32%/1.82% regime=norm [AUTO]
```

- `regime`: `norm` (normal), `high` (high volatility), `low ` (low volatility)
- `[AUTO]` — autoSpacingPriority=`auto` (применяется к торговле); `[CFG]` — `config` (только лог)

### Telegram-алерты

**Fill notifications** (при каждом исполнении grid-ордера):
```
🔵 BUY AAVE/USDT 0.0565 @ 103.2800  Cost: 5.84 USDT
🔴 SELL AAVE/USDT 0.0564 @ 105.29   Earned: 5.94 USDT (+0.10)
```

**State changes** (команды/авто-переводы):
```
🧊 XRP/USDT — покупки заморожены
🔻 XRP/USDT — sellgrid включён, позиция распродаётся ladder-up
🧊❄️ XRP/USDT — полная заморозка, SL/TP остаются
🗑 XRP/USDT удалена. Отменено ордеров: 5.
✅ XRP/USDT — полностью разморожена
```

**Dust auto-detection**:
```
🧊 XRP/USDT — sellgrid завершён (остаток &lt; 1$). Покупки заморожены, оставшиеся продажи активны.
```

**Auto-spacing report** (каждые N минут):
```
📐 Auto-spacing report (safetyMargin=0%, qtySigmas=1)
DOT/USDT:    1.38%/1.88% (norm)
NEAR/USDT:   1.19%/1.69% (norm)
...
```

## Важные замечания

- Обязательно начинайте с `USE_TESTNET=true` и небольших сумм
- При маленьком капитале (<$200) ордера могут быть ниже minAmount/minCost биржи — бот пропустит их с логом
- При свежем старте с уже имеющейся криптой на бирже — position tracking начинается с 0, SL/TP не сработает на купленные вручную монеты
- Удалите `bot-state.json` при смене пар или после крупных обновлений
- Это не финансовый совет. Торговля несёт риск потери средств.
