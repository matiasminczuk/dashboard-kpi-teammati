const flows = ['SDC', 'CCC', 'FO', 'SCP'];
const clean = value => String(value ?? '').trim();
const normalize = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
const number = value => clean(value) === '' ? NaN : Number(clean(value).replace(',', '.'));

function score(value) {
  const raw = clean(value);
  const n = number(raw.replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return raw.endsWith('%') || n > 1 ? n / 100 : n;
}

function dayKey(value) {
  if (value instanceof Date && Number.isFinite(+value)) return value.toISOString().slice(0, 10);
  const raw = clean(value);
  const local = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const iso = local ? [local[3], local[2].padStart(2, '0'), local[1].padStart(2, '0')].join('-') : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const parsed = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === iso ? iso : '';
}

function shiftDay(day, days) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekStart(key) {
  const match = clean(key).match(/^(\d{4})-?W(\d{1,2})$/i);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 53) return '';
  const mondayOf = year => {
    const jan4 = year + '-01-04';
    return shiftDay(jan4, -((new Date(jan4).getUTCDay() + 6) % 7));
  };
  const monday = shiftDay(mondayOf(match[1]), 7 * (Number(match[2]) - 1));
  return monday < mondayOf(Number(match[1]) + 1) ? monday : '';
}

export function monthAt(year, month) {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 7);
}

export function qualityPeriods({mode, year, month, quarter, from, to}) {
  if (mode === 'weeks') {
    const start = weekStart(from), last = weekStart(to);
    if (!start || !last || start > last) return null;
    const end = shiftDay(last, 7);
    const days = (Date.parse(end) - Date.parse(start)) / 86400000;
    return {current: {start, end}, previous: {start: shiftDay(start, -days), end: start}};
  }
  if (!year || (mode === 'month' && !month) || (mode !== 'month' && !quarter)) return null;
  const width = mode === 'month' ? 1 : 3;
  const first = mode === 'month' ? month : (quarter - 1) * 3 + 1;
  const start = monthAt(year, first) + '-01';
  return {current: {start, end: monthAt(year, first + width) + '-01'},
    previous: {start: monthAt(year, first - width) + '-01', end: start}};
}

const monthKey = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(clean(value)) ? clean(value) : '';
const sourceOf = value => /\binternas?\b/.test(normalize(value)) ? 'interna' :
  /\bmeli\b|mercado libre/.test(normalize(value)) ? 'meli' : '';
const flowOf = value => flows.find(flow => normalize(value).split(/[^a-z]+/).includes(flow.toLowerCase())) || '';
const columns = {
  person: ['id meli', 'id colaborador', 'colaborador', 'usuario', 'catalogador'],
  audited: ['q tareas auditadas', 'tareas auditadas', 'auditorias', 'evaluaciones', 'cantidad auditada'],
  score: ['% efectividad', 'efectividad', '% calidad', 'calidad'],
  errors: ['errores', 'cantidad de errores'], action: ['accion'], flow: ['flujo'],
  source: ['origen', 'fuente', 'tipo de auditoria'], day: ['fecha', 'fecha auditoria'],
  week: ['semana'], month: ['mes', 'periodo'], audit: ['id auditoria', 'id evaluacion']
};

export function indexPeople(people) {
  const ids = new Map(), aliases = new Map();
  for (const person of people) {
    ids.set(normalize(person.id), person);
    for (const value of [person.id, person.name, ...person.aliases]) {
      const alias = normalize(value);
      if (!alias) continue;
      const matches = aliases.get(alias) || new Set();
      matches.add(person.id);
      aliases.set(alias, matches);
    }
  }
  return value => {
    const key = normalize(value), matches = aliases.get(key);
    if (ids.has(key)) return ids.get(key);
    if (matches?.size !== 1) return null;
    return people.find(person => person.id === [...matches][0]);
  };
}

export function analyzeQuality(sheets, resolvePerson, fallbackMonth) {
  const entries = new Map(), conflicted = new Set(), rejected = [], sheetColumns = [];
  let processed = 0, duplicates = 0;
  for (const {name, rows} of sheets) {
    const headerIndex = rows.findIndex(row => {
      const names = row.map(normalize);
      return ['person', 'audited', 'score'].every(field => columns[field].some(label => names.includes(label)));
    });
    if (headerIndex < 0) {
      if (rows.length) rejected.push({sheet: name, row: '—', reason: 'Faltan las columnas de colaborador, cantidad auditada o efectividad.'});
      continue;
    }
    const header = rows[headerIndex].map(normalize);
    const index = Object.fromEntries(Object.entries(columns).map(([field, labels]) => [field, labels.map(label => header.indexOf(label)).find(i => i >= 0) ?? -1]));
    sheetColumns.push({sheet: name, columns: rows[headerIndex].filter(value => clean(value))});
    for (const [offset, row] of rows.slice(headerIndex + 1).entries()) {
      if (!row.some(value => clean(value))) continue;
      processed++;
      const at = field => row[index[field]];
      const location = {sheet: name, row: headerIndex + offset + 2};
      const reject = reason => rejected.push({...location, reason});
      const person = resolvePerson(at('person'));
      const flow = flowOf(at('flow') || name), source = sourceOf(at('source') || name);
      const audited = number(at('audited')), effectiveness = score(at('score'));
      const errors = clean(at('errors')) ? number(at('errors')) : null;
      const date = dayKey(at('day')), week = weekStart(at('week'));
      const month = monthKey(at('month') || fallbackMonth);
      if (!person) { reject('Catalogador sin coincidencia única en Firebase.'); continue; }
      if (!flow || !source) { reject('Falta el flujo o el origen de la auditoría.'); continue; }
      if (!Number.isSafeInteger(audited) || audited <= 0 || effectiveness === null ||
          (errors !== null && (!Number.isSafeInteger(errors) || errors < 0))) {
        reject('Cantidad auditada, efectividad o errores inválidos.'); continue;
      }
      if ((clean(at('day')) && !date) || (clean(at('week')) && !week) || (clean(at('month')) && !month)) {
        reject('Fecha, semana o mes inválido.'); continue;
      }
      if (!date && !week && !month) { reject('Seleccioná el mes de referencia para las filas sin fecha.'); continue; }
      const action = clean(at('action'));
      const record = {source, flow, action, audited, effectiveness, errors,
        start: date || week || month + '-01', unit: date ? 'day' : week ? 'week' : 'month'};
      const key = JSON.stringify([person.id, source, flow, normalize(action), record.start, record.unit, normalize(at('audit'))]);
      const previous = entries.get(key);
      if (conflicted.has(key)) { reject('Fila en conflicto con otro resultado para la misma clave.'); continue; }
      if (previous) {
        const same = ['audited', 'effectiveness', 'errors'].every(field => previous.record[field] === record[field]);
        if (same) { duplicates++; continue; }
        entries.delete(key);
        conflicted.add(key);
        rejected.push({...previous.location, reason: 'Resultado en conflicto para la misma clave.'});
        reject('Resultado en conflicto para la misma clave.');
        continue;
      }
      entries.set(key, {key, person, record, location});
    }
  }
  return {entries: [...entries.values()], processed, duplicates, rejected, sheetColumns};
}

export function restoreArchivedQuality(manifest, blocks) {
  if (manifest.estado !== 'completado' || !Array.isArray(manifest.hojas) || blocks.length !== manifest.bloques) {
    throw new Error('La base archivada está incompleta.');
  }
  const sheets = manifest.hojas.map((sheet, index) => {
    const rows = [];
    const parts = blocks.filter(block => block.indiceHoja === index).sort((a, b) => a.filaInicial - b.filaInicial);
    for (const block of parts) {
      if (block.filaInicial !== rows.length || !Array.isArray(block.filas)) throw new Error('Faltan bloques de «' + sheet.nombre + '».');
      for (const row of block.filas) {
        if (row.fila !== rows.length || !Array.isArray(row.celdas)) throw new Error('Hay filas incompletas en «' + sheet.nombre + '».');
        rows.push(row.celdas);
      }
    }
    if (rows.length !== sheet.filas) throw new Error('La cantidad de filas no coincide en «' + sheet.nombre + '».');
    return {name: sheet.nombre, rows};
  });
  if (sheets.reduce((total, sheet) => total + sheet.rows.length, 0) !== manifest.filasTotales) {
    throw new Error('La cantidad total de filas archivadas no coincide.');
  }
  return sheets;
}

export function summary(records) {
  const audited = records.reduce((sum, row) => sum + row.audited, 0);
  const earned = records.reduce((sum, row) => sum + row.audited * row.effectiveness, 0);
  const errors = records.length && records.every(row => row.errors !== null)
    ? records.reduce((sum, row) => sum + row.errors, 0) : null;
  return {audited, quality: audited ? earned / audited : null, errors};
}

export function selectQualityPeriod(records, period, weekly) {
  const group = row => JSON.stringify([row.id, row.source, row.flow, normalize(row.action), row.start.slice(0, 7)]);
  const monthly = new Set(records.filter(row => row.unit === 'month').map(group));
  const weeks = new Set(records.filter(row => row.unit === 'week').map(row => JSON.stringify([row.id,row.source,row.flow,normalize(row.action),row.start])));
  return records.filter(row => {
    if (row.start < period.start || row.start >= period.end) return false;
    if (weekly && row.unit === 'month') return false;
    if (!weekly && row.unit !== 'month' && monthly.has(group(row))) return false;
    if (row.unit === 'day') {
      const monday = shiftDay(row.start, -((new Date(row.start).getUTCDay() + 6) % 7));
      if (weeks.has(JSON.stringify([row.id,row.source,row.flow,normalize(row.action),monday]))) return false;
    }
    return true;
  });
}

export function bucketQuality(records, cadence) {
  const buckets = new Map();
  for (const row of records) {
    if (cadence === 'weeks' && row.unit === 'month') continue;
    const key = cadence === 'weeks'
      ? shiftDay(row.start, -((new Date(row.start).getUTCDay() + 6) % 7))
      : row.start.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({key, ...summary(rows)}));
}
