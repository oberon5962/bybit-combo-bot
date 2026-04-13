# Bybit Combo Bot — Grid + DCA + Meta-signals

Торговый бот для спот-рынка Bybit, комбинирующий три стратегии: сеточную торговлю (Grid), усреднение позиции (DCA) с фильтром по RSI, и мета-сигналы на основе технических индикаторов. Все ордера отслеживаются через систему позиций с автоматическим стоп-лоссом, тейк-профитом и trailing stop-loss.

## Стек

- **TypeScript** + ts-node
- **CCXT** — Bybit V5 API (spot)
- **Winston** — логирование (файл + консоль)
- **dotenv** — конфигурация API ключей

## Структура проекта

```
bybit-combo-bot/
├── .env.example              # Шаблон для API ключей
├── .env                      # API ключи (не коммитится)
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
├── bot-state.json            # Состояние бота (создаётся автоматически)
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
    └── strategies/
        ├── grid.ts           # Grid-стратегия (сетка лимитных ордеров + counter-orders)
        ├── dca.ts            # DCA-стратегия с RSI-фильтром (отключена)
        └── combo-manager.ts  # Оркестратор — стратегии, SL/TP/TSL, cooldown, market panic
```

## Текущая конфигурация

| Параметр | Значение | Описание |
|---|---|---|
| **Пары** | SUI/USDT 25%, SOL/USDT 40%, XRP/USDT 35% | 3 пары, суммарная аллокация 100% |
| **Режим** | USE_TESTNET=true | Тестовая сеть Bybit |
| **Капитал** | ~$300 USDT | На реальном Bybit |
| **Tick интервал** | 10 сек | Проверка рынка каждые 10 секунд |
| **Sync интервал** | 6 часов | Полная синхронизация с Bybit |

### Grid

| Параметр | Значение |
|---|---|
| gridLevels | 20 (10 buy + 10 sell) |
| gridSpacingPercent | 0.5% |
| orderSizePercent | 14% от аллокации пары |
| rebalancePercent | 2% (вверх или вниз от центра) |
| rsiOverboughtThreshold | 70 (100 = отключить) |
| useEmaFilter | true (false = отключить) |

### Risk Management

| Параметр | Значение |
|---|---|
| stopLossPercent | 14% |
| takeProfitPercent | 12% |
| trailingSLPercent | 5% (trailing) |
| trailingSLActivationPercent | 3% (активация trailing) |
| maxDrawdownPercent | 15% |
| portfolioTakeProfitPercent | 100% |
| cooldownAfterSLSec | 7200 (2 часа) |
| cooldownMaxSL | 3 (3 SL подряд = halt) |

### Market Protection

| Параметр | Значение |
|---|---|
| panicBearishPairsThreshold | 2 (2 из 3 bearish = cancel all buys) |
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

## Торговая стратегия

### 1. Grid (сеточная торговля)

Размещает сетку лимитных ордеров на покупку ниже текущей цены и на продажу выше. Когда покупка исполняется — бот ставит контр-ордер на продажу на уровень выше (+ gridSpacing%). Когда продажа исполняется — ставит контр-ордер на покупку ниже. Зарабатывает на каждом колебании цены внутри диапазона.

**Фильтры для buy-ордеров:**
- RSI > rsiOverboughtThreshold (70) — grid buy пропускается
- EMA bearish crossover (fast < slow) — grid buy пропускается

**Rebalance:** если цена ушла >2% от центра сетки (вверх или вниз) — все ордера отменяются и сетка пересоздаётся.

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
9. Каждые 10 тиков — сводка (summary log)

## Управление рисками

### Многоуровневая защита

1. **Hard Stop-Loss (14%)** — цена упала на 14% от avg entry → market sell + cooldown
2. **Trailing Stop-Loss (5%, активация +3%)** — после роста >3% от entry включается trailing; если цена падает на 5% от пика → sell. Обычно фиксирует прибыль.
3. **Take-Profit (12%)** — цена выросла на 12% от entry → market sell + reset
4. **Portfolio Take-Profit (100%)** — портфель удвоился → sell everything + halt
5. **Max Drawdown (15%)** — портфель упал на 15% от пика → halt
6. **Cooldown** — после SL пауза 2 часа; 3 SL подряд = halt до ручного вмешательства
7. **Market Panic** — 2+ из 3 пар bearish EMA → cancel all buy orders
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

- **Ctrl+C** (1 раз) — soft shutdown, grid-ордера остаются на бирже
- **Ctrl+C** (2 раза) — hard shutdown, все ордера отменяются
- **Автоматически** — при SL/TP/drawdown/portfolio TP

### Возобновление после halt

1. Проанализировать логи
2. `bot-state.json`: поставить `"halted": false` или удалить файл (чистый старт)
3. Для per-pair halt: в `pairStates` → `"halted": false`, `"consecutiveSL": 0`
4. Перезапустить

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

## Важные замечания

- Обязательно начинайте с `USE_TESTNET=true` и небольших сумм
- При маленьком капитале (<$200) ордера могут быть ниже minAmount/minCost биржи — бот пропустит их с логом
- При свежем старте с уже имеющейся криптой на бирже — position tracking начинается с 0, SL/TP не сработает на купленные вручную монеты
- Удалите `bot-state.json` при смене пар или после крупных обновлений
- Это не финансовый совет. Торговля несёт риск потери средств.
