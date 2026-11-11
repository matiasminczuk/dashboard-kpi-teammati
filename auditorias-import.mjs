const labels = {
  externo:'ID de auditoría', idMeli:'Identificador del colaborador', fecha:'Fecha de auditoría',
  periodo:'Período', tipo:'Tipo', flujo:'Flujo', resultado:'Resultado original',
  observaciones:'Observaciones del auditor', auditor:'Auditor', cdm:'ID CDM',
  producto:'Product ID', item:'Item ID', variante:'Variation ID',
  comentarioOrigen:'Comentario del colaborador en origen', referencia:'Link de origen',
  decisionOrigen:'Decisión del colaborador en origen', estadoOrigen:'Estado en origen', motivoOrigen:'Motivo en origen'
};
const aliases = {
  externo:['id auditoria', 'id de auditoria', 'auditoria id'],
  idMeli:['id meli', 'id colaborador', 'colaborador', 'usuario'],
  fecha:['fecha auditoria', 'fecha de auditoria', 'fecha'],
  periodo:['periodo', 'mes'], tipo:['tipo auditoria', 'tipo de auditoria', 'tipo'],
  flujo:['flujo', 'proceso'], resultado:['resultado', 'accion correcta'],
  observaciones:['observaciones', 'comentario auditor'], auditor:['auditor'],
  cdm:['id cdm'], producto:['product id'], item:['item id'], variante:['variation id'],
  comentarioOrigen:['comentario colab'], referencia:['link'],
  decisionOrigen:['decision colaborador'], estadoOrigen:['estado'], motivoOrigen:['motivo']
};
const normalized = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().trim().replace(/[_\s]+/g, ' ');
const valueOf = value => String(value ?? '').trim();
const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const pad = value => String(value).padStart(2, '0');

export {labels};

export function mapHeaders(headers) {
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => {
    const candidates = headers.map(normalized).flatMap((value, index) => names.includes(value) ? [index] : []);
    return [key, candidates.length === 1 ? candidates[0] : -1];
  }));
}

export function auditDate(value, serialDate) {
  if (value instanceof Date && Number.isFinite(+value)) {
    return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
  }
  if (typeof value === 'number') {
    const parsed = serialDate(value);
    if (parsed) return parsed.y + '-' + pad(parsed.m) + '-' + pad(parsed.d);
  }
  const text = valueOf(value);
  const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (local) return local[3] + '-' + pad(local[2]) + '-' + pad(local[1]);
  const named = /^(\d{1,2})\s+(\p{L}+)\.?\s+(\d{4})$/iu.exec(text);
  if (named) {
    const month = months.indexOf(normalized(named[2]).slice(0, 3));
    if (month >= 0) return named[3] + '-' + pad(month + 1) + '-' + pad(named[1]);
  }
  return text;
}

export function mapAuditRows(sheet, defaultPeriod, serialDate) {
  const {matrix, mapping, name, headerRow, composite} = sheet;
  const required = ['idMeli', 'resultado'];
  if (!composite) required.push('externo');
  if (composite) required.push('fecha', 'flujo', 'cdm', 'producto', 'item', 'variante');
  if (required.some(key => mapping[key] < 0)) throw Error(name + ' · Completá el mapeo de los campos requeridos.');
  if (mapping.fecha < 0 && mapping.periodo < 0 && !defaultPeriod) throw Error(name + ' · Mapeá fecha o período, o indicá un mes de referencia.');
  return matrix.slice(headerRow + 1).flatMap((cells, index) => {
    if (!cells.some(cell => valueOf(cell))) return [];
    const row = {hoja:name, fila:headerRow + index + 2};
    for (const key of Object.keys(labels)) {
      const cell = cells[mapping[key]];
      row[key] = key === 'fecha' ? auditDate(cell, serialDate) : valueOf(cell);
    }
    if (!row.fecha) row.periodo ||= defaultPeriod;
    if (composite) {
      row.externo = row.fecha && row.flujo && row.cdm && row.producto && row.item ?
        'netkel:' + JSON.stringify([row.fecha, row.flujo.toUpperCase(), row.idMeli.toLowerCase(),
          row.cdm, row.producto, row.item, row.variante]) : '';
    }
    return [row];
  });
}

export function hasNetkelColumns(mapping) {
  return ['fecha','flujo','idMeli','cdm','producto','item','variante'].every(key => mapping[key] >= 0);
}
