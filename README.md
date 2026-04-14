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
├── check-bybit.ts            # Диагностика: балансы, ордера, тикеры, последние сделки
├── register-commands.ts      # Одноразовая регистрация меню команд в Telegram
├── bot.log                   # Лог работы (создаётся автоматически)
├── errors.log                # Только ошибки
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
    └── strategies/
        ├── grid.ts           # Grid-стратегия (сетка лимитных ордеров + counter-orders)
        ├── dca.ts            # DCA-стратегия с RSI-фильтром (отключена)
        └── combo-manager.ts  # Оркестратор — стратегии, SL/TP/TSL, cooldown, market panic
```

## Текущая конфигурация

| Параметр | Значение | Описание |
|---|---|---|
| **Пары** | SUI/USDT 25%, SOL/USDT 40%, XRP/USDT 35% | 3 пары, суммарная аллокация 100% |
| **Режим** | USE_TESTNET=false | Mainnet Bybit |
| **Капитал** | ~$304 USDT | На реальном Bybit |
| **Tick интервал** | 10 сек | Проверка рынка каждые 10 секунд |
| **Sync интервал** | 6 часов | Полная синхронизация с Bybit |

### Grid

| Параметр | Значение |
|---|---|
| gridLevels | 10 (5 buy + 5 sell) |
| gridSpacingPercent | 0.8% (buy) |
| gridSpacingSellPercent | 1.4% (sell) |
| orderSizePercent | 12% от аллокации пары |
| rebalancePercent | 3% (вверх или вниз от центра) |
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

### Telegram-команды

Управление ботом через Telegram (команды обрабатываются даже когда бот остановлен):

| Команда | Описание |
|---|---|
| `/status` | Сводка: капитал, PnL, позиции по всем парам |
| `/stop` | Остановить торговлю (halted=true) |
| `/run` | Возобновить торговлю (сбрасывает halt, cooldown, consecutiveSL) |
| `/sellall` | Продать все позиции + отменить ордера + halt |
| `/buy SUI 10` | Купить 10 токенов SUI за USDT (market order) |
| `/buy SUI/BTC 10` | Купить 10 токенов SUI за BTC (market order) |
| `/orders` | Показать все открытые ордера |

Ручные покупки через `/buy` не входящих в конфиг пар отслеживаются отдельно (`manualPairs`), отображаются в `/status` и `/orders`, продаются по `/sellall`.

**Регистрация меню команд** (одноразово):
```bash
npx ts-node register-commands.ts
```
После этого в Telegram при нажатии `/` появится меню с описанием всех команд.

## Торговая стратегия

### 1. Grid (сеточная торговля)

Размещает сетку лимитных ордеров на покупку ниже текущей цены и на продажу выше. Buy-уровни с шагом 0.8%, sell-уровни с шагом 1.4% (раздельные spacing). Когда покупка исполняется — бот ставит контр-ордер на продажу на уровень выше (+ gridSpacingSell%). Когда продажа исполняется — ставит контр-ордер на покупку ниже. Зарабатывает на каждом колебании цены внутри диапазона.

**Bollinger Bands Adaptive Grid:** когда цена у нижней полосы BB — больше buy-уровней (shift +2) и увеличенный orderSize (x1.5). Когда у верхней BB + bearish EMA — больше sell-уровней и увеличенный sell size. При bullish EMA sell не усиливается.

**Фильтры для buy-ордеров:**
- RSI > rsiOverboughtThreshold (70) — grid buy пропускается
- EMA фильтр отключён (useEmaFilter=false)

**Rebalance:** если цена ушла >3% от центра сетки (вверх или вниз) — все ордера отменяются и сетка пересоздаётся.

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

### Процедура закрытия позиции (SL/TP)

1. Отменяются все grid-ордера по паре (`grid.cancelAll`)
2. Ожидание 1 секунду
3. Загружаются свежие балансы
4. `Math.min(free, positionAmount)` — не продаём больше доступного
5. Округление до market precision (`Math.floor` + minAmount/minCost check)
6. Market sell
7. Обновление position + trade record
8. Cooldown или halt в зависимости от consecutiveSL count

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

### v0.7.0 — `6d59eb2` (2026-04-13)

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

### v0.8.0 — `8e5b3fa` (2026-04-14)

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

**Аудит раунд 1 — 7 багов (коммит `a13b9c4`):**
- grid.ts: cancelled-check был unreachable (dead branch) — переставлен вверх
- grid.ts: counter-price использует actualPrice (реальный fill), а не filledPrice (лимитный)
- grid.ts: orphan-sell использует freeBal напрямую + guard для orderAmount<=0
- sync.ts: partial-fill-then-cancel detection (filled>0 независимо от статуса)
- exchange.ts: `tickSizeToDecimalPlaces(1)` возвращает 0 вместо 1
- combo-manager.ts: не обнуляет позицию после partial closePosition (SL/TP/trailing)
- state.ts: порог reducePosition унифицирован до 1e-12

**Аудит раунд 2 — 5 багов (коммит `8e5b3fa`):**
- combo-manager.ts: market panic чистит orderId в grid state после отмены buy-ордеров
- sync.ts: filled ордера при sync флипают level на counter-side (counter-order на следующем тике)
- indicators.ts: EMA seed = SMA(period) вместо одного значения (точные сигналы при малом количестве свечей)
- indicators.ts: NaN forward-fill вместо filter (сохраняет индексы массива для crossover detection)
- index.ts: shutdown race fix — `shuttingDown` flag блокирует тики при shutdown

### v1.0.0 — `14204bb` (2026-04-14)

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

### v0.9.0 — `054afbd` (2026-04-14)

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

### v1.2.1 (2026-04-15)

Аудит Telegram-команд: 1 high, 4 medium багов.

**Фиксы:**
- **HIGH: lastUpdateId не сохранялся при рестарте** — рестарт мог повторно выполнить `/sellall` или `/buy`. Теперь `telegramUpdateId` персистится в `bot-state.json`
- **MEDIUM: `/stop` подсказывал `/start` вместо `/run`** — пользователь не мог возобновить бота по подсказке
- **MEDIUM: callback_data без проверки длины** — Telegram молча обрезает данные >64 байт, длинные аргументы `/buy` могли исказиться. Добавлена валидация
- **MEDIUM: ложный reload конфига на первом тике** — hash инициализировался пустой строкой, первая проверка всегда считала конфиг "изменённым". Теперь hash вычисляется в `init()`
- **MEDIUM: hot-reload пересоздавал TelegramNotifier** — терялась очередь сообщений и сбрасывался `lastSummaryTick` (summary в Telegram приходило чаще 10 мин). Теперь `updateConfig()` вместо `new TelegramNotifier()`

### v1.2.0 — `5af78b9` (2026-04-15)

Управление ботом через Telegram-команды.

**Telegram-команды (`telegram.ts` + `combo-manager.ts`):**
- 6 команд: `/status`, `/stop`, `/run`, `/sellall`, `/buy`, `/orders`
- Подтверждение [✅ Да / ❌ Нет] для опасных команд: `/stop`, `/sellall`, `/buy`
- Non-blocking polling через `getUpdates` с `timeout=0`
- Безопасность: команды принимаются только от настроенного `chatId`
- Команды обрабатываются до проверки `halted` — `/buy` и `/run` работают при остановленном боте
- `lastUpdateId` персистится в state (нет повторной обработки команд при рестарте)
- `commandPollIntervalTicks` — частота опроса Telegram (по умолчанию каждый тик)

**Ручные покупки (`/buy`):**
- Два формата: `/buy SUI 10` (за USDT) и `/buy SUI/BTC 10` (за BTC)
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

### v1.1.0 — `958b19e` (2026-04-14)

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

## Важные замечания

- Обязательно начинайте с `USE_TESTNET=true` и небольших сумм
- При маленьком капитале (<$200) ордера могут быть ниже minAmount/minCost биржи — бот пропустит их с логом
- При свежем старте с уже имеющейся криптой на бирже — position tracking начинается с 0, SL/TP не сработает на купленные вручную монеты
- Удалите `bot-state.json` при смене пар или после крупных обновлений
- Это не финансовый совет. Торговля несёт риск потери средств.
