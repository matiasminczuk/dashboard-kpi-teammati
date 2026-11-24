import {normalizeLabel,operationalFlow} from './gestion-desarrollo.mjs';

export const pmFlowLabels = {mixto:'Flujo Mixto',soporte:'Soporte',kv:'Known Values'};

export function pmOperationalFlow(value) {
  const name=normalizeLabel(value).replace(/^analista /,'');
  if (/^(kv|know(n|ns|s)? values?)( \(kv\))?$/.test(name)) return 'kv';
  return operationalFlow(value);
}

export function initiativeFlow(value) {
  const name = normalizeLabel(value);
  if (pmOperationalFlow(name)==='kv') return 'kv';
  if (['soporte','support','denuncias bpp','unificacion de familias','separacion de familias',
    'merge de productos','denuncia bpp uso indebido de marca','analisis y correccion de knowns values',
    'sugerencias de correccion','sugerencias de creacion'].includes(name)) return 'soporte';
  return 'mixto';
}

export function pmTaskDistribution(rows) {
  const groups = {mixto:0,soporte:0,kv:0};
  for (const row of rows) {
    for (const [initiative,raw] of Object.entries(row.flujos || {})) {
      const count = Number(raw);
      if (Number.isFinite(count) && count > 0) groups[initiativeFlow(initiative)] += count;
    }
  }
  return groups;
}

export function pmPeopleDistribution(rows) {
  const people = new Map();
  for (const row of rows) {
    if (!row.id || row.tipo !== 'tareas') continue;
    const previous = people.get(row.id);
    // El registro más reciente define un único flujo para cada colaborador.
    if (!previous || row.fecha > previous.fecha) people.set(row.id,row);
  }
  const groups = {mixto:0,soporte:0,kv:0};
  for (const row of people.values()) groups[pmOperationalFlow(row.flujoOperativo || row.rolOrigen)]++;
  return groups;
}
