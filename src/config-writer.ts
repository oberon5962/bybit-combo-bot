// ============================================================
// Bybit Combo Bot — Config Writer
// Атомарно обновляет поля в config.jsonc (JSONC с комментариями).
// Работает построчно — один символ = одна строка в pairs[].
// ============================================================

import { readFileSync, writeFileSync, renameSync } from 'fs';

// Обновить одно поле для конкретной пары в config.jsonc.
// value === null → удалить поле из строки (используется для сброса state → unfreeze).
function updatePairField(
  configPath: string,
  symbol: string,
  fieldName: string,
  value: string | number | null,
): void {
  const content = readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');
  const symbolJson = `"symbol": "${symbol}"`;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(symbolJson)) continue;

    let line = lines[i];

    if (value === null) {
      // Удалить поле: ищем ", "field": value" или ", "field": "value""
      line = line.replace(
        new RegExp(`,\\s*"${fieldName}":\\s*(?:"[^"]*"|[\\d.]+)`),
        '',
      );
    } else {
      const fieldPattern = new RegExp(`"${fieldName}":\\s*(?:"[^"]*"|[\\d.]+)`);
      const formatted =
        typeof value === 'string'
          ? `"${fieldName}": "${value}"`
          : `"${fieldName}": ${value}`;

      if (fieldPattern.test(line)) {
        line = line.replace(fieldPattern, formatted);
      } else {
        // Добавить перед закрывающей }
        line = line.replace(/(\s*}\s*,?\s*)$/, (tail) => {
          const trailingComma = tail.trimStart().startsWith('}') ? tail.slice(tail.indexOf('}')) : '';
          const prefix = tail.slice(0, tail.indexOf('}'));
          return `${prefix}, ${formatted}${trailingComma}`;
        });
      }
    }

    lines[i] = line;
    break;
  }

  const tmp = configPath + '.tmp';
  writeFileSync(tmp, lines.join('\n'), 'utf-8');
  renameSync(tmp, configPath);
}

// Обновить state пары. state === null или 'unfreeze' → удаляет поле (возврат к default).
export function updatePairStateInConfig(
  configPath: string,
  symbol: string,
  state: string | null,
): void {
  if (state === null || state === 'unfreeze') {
    updatePairField(configPath, symbol, 'state', null);
  } else {
    updatePairField(configPath, symbol, 'state', state);
  }
}

// Обновить gridSpacingPercent и gridSpacingSellPercent для пары (auto-spacing sync).
export function updatePairSpacingInConfig(
  configPath: string,
  symbol: string,
  buySpacing: number,
  sellSpacing: number,
): void {
  // Читаем файл один раз и делаем оба обновления за одну запись
  const content = readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');
  const symbolJson = `"symbol": "${symbol}"`;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(symbolJson)) continue;

    let line = lines[i];

    const updateField = (fname: string, val: number): string => {
      const pat = new RegExp(`"${fname}":\\s*[\\d.]+`);
      const fmt = `"${fname}": ${val}`;
      if (pat.test(line)) return line.replace(pat, fmt);
      // Добавить перед }
      return line.replace(/(\s*}\s*,?\s*)$/, (tail) => {
        const closingIdx = tail.indexOf('}');
        return `${tail.slice(0, closingIdx)}, ${fmt}${tail.slice(closingIdx)}`;
      });
    };

    line = updateField('gridSpacingPercent', buySpacing);
    line = updateField('gridSpacingSellPercent', sellSpacing);
    lines[i] = line;
    break;
  }

  const tmp = configPath + '.tmp';
  writeFileSync(tmp, lines.join('\n'), 'utf-8');
  renameSync(tmp, configPath);
}
