import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeQuality, indexPeople, qualityPeriods, selectQualityPeriod, summary, bucketQuality, weekStart} from './calidad.mjs';

const findPerson = indexPeople([
  {id: 'meli-a', name: 'Persona A', aliases: ['ext_a', 'compartido']},
  {id: 'meli-b', name: 'Persona B', aliases: ['ext_b', 'compartido']}
]);
const header = ['Colaborador', 'Q Tareas auditadas', '% Efectividad'];

test('interpreta hojas reales, normaliza porcentajes y rechaza aliases ambiguos', () => {
  const result = analyzeQuality([
    {name: 'Auditorias Internas - SDC', rows: [header, ['EXT_A', 30, '80%'], ['ext_a', 30, 0.8], ['ext_b', 10, 1], ['compartido', 4, 1]]},
    {name: 'Auditorias MELI - FO', rows: [[...header, 'Acción'], ['meli-a', 5, 50, 'ADD']]}
  ], findPerson, '2026-10');
  assert.equal(result.processed, 5);
  assert.equal(result.duplicates, 1);
  assert.equal(result.rejected.length, 1);
  const rows = result.entries.map(entry => entry.record);
  assert.deepEqual(summary(rows.filter(row => row.source === 'interna')), {audited: 40, quality: 0.85, errors: null});
  assert.equal(rows[2].flow, 'FO');
  assert.equal(rows[2].action, 'ADD');
  assert.equal(rows[0].start, '2026-10-01');
});

test('rechaza fechas inválidas, resultados sin período y filas contradictorias', () => {
  const result = analyzeQuality([{name: 'Auditorias Internas - CCC', rows: [
    [...header, 'Fecha'], ['ext_a', 4, '50%', '2026-10-09'], ['ext_a', 5, '50%', '2026-10-09'],
    ['ext_b', 4, '50%', '2026-10-40'], ['ext_b', 4, '50%', '']
  ]}], findPerson, '');
  assert.equal(result.entries.length, 0);
  assert.equal(result.rejected.length, 4);
  assert.equal(weekStart('2025-W53'), '');
  assert.equal(weekStart('2026-W53'), '2026-12-28');
});

test('filtra semanas y meses sin duplicar totales ni estimar errores', () => {
  const oct = qualityPeriods({mode: 'month', year: 2026, month: 10});
  assert.deepEqual(oct.previous, {start: '2026-09-01', end: '2026-10-01'});
  const weeks = qualityPeriods({mode: 'weeks', from: '2026-W40', to: '2026-W41'});
  assert.deepEqual(weeks.previous, {start: '2026-09-14', end: '2026-09-28'});
  const records = [
    {id: 'meli-a', flow: 'SDC', source: 'interna', start: '2026-10-01', unit: 'month', audited: 40, effectiveness: 0.9, errors: null},
    {id: 'meli-a', flow: 'SDC', source: 'interna', start: '2026-10-06', unit: 'day', audited: 10, effectiveness: 0.6, errors: 3},
    {id: 'meli-a', flow: 'SDC', source: 'interna', start: '2026-09-01', unit: 'month', audited: 20, effectiveness: 0.8, errors: null}
  ];
  assert.deepEqual(summary(selectQualityPeriod(records, oct.current, false)), {audited: 40, quality: 0.9, errors: null});
  assert.deepEqual(bucketQuality(selectQualityPeriod(records, weeks.current, true), 'weeks'), [
    {key: '2026-10-05', audited: 10, quality: 0.6, errors: 3}
  ]);
  assert.deepEqual(summary([]), {audited: 0, quality: null, errors: null});
});
