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
const correctionLink = /^https:\/\/catalog-domains\.adminml\.com\/catalogo\/bc-admin\/sugerencias\/revision\/[a-z]{3,4}s\d+\/?(?:[?#].*)?$/i;
const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const pad = value => String(value).padStart(2, '0');

export {labels};

export function auditSourceFlow({flujo, referencia}) {
  const explicit = valueOf(flujo);
  if (explicit && normalized(explicit) !== 'null') return explicit;
  return correctionLink.test(valueOf(referencia)) ? 'SDC' : '';
}

const correctionColumns = {externo:'correction id', auditor:'auditor tl', observaciones:'comentario tl',
  estadoOrigen:'estado sugerencia', motivoOrigen:'suggestion reason'};

function uniqueColumn(headers, names) {
  const candidates = headers.flatMap((value, index) => names.includes(value) ? [index] : []);
  return candidates.length === 1 ? candidates[0] : -1;
}

function isCorrectionExport(headers) {
  return ['correction id','suggestion id','accion correcta','fecha auditoria','colaborador']
    .every(name => uniqueColumn(headers, [name]) >= 0);
}

function creationColumns(headers) {
  const names=headers.map(normalized);
  const find=(...aliases)=>{const matches=names.flatMap((name,index)=>aliases.includes(name)?[index]:[]);return matches.length===1?matches[0]:-1;};
  const columns={suggestion:find('suggestion id'),attribute:find('atributo/seccion'),decision:find('decision colab'),
    check:find('check tl'),reasonCheck:find('check motivo tl'),action:find('accion correcta'),
    collaborator:find('colaborador'),date:find('fecha auditoria'),auditor:find('auditor tl'),
    reason:find('codigo rechazo'),comment:find('comentario'),state:find('estado sugerencia v2')};
  return ['suggestion','attribute','decision','check','reasonCheck','action','collaborator','date'].every(key=>columns[key]>=0)?columns:null;
}

export function mapHeaders(headers) {
  const creation=creationColumns(headers);
  if(creation){
    const result=Object.fromEntries(Object.keys(labels).map(key=>[key,-1]));
    for(const [key,column] of Object.entries({externo:'suggestion',idMeli:'collaborator',fecha:'date',resultado:'action',decisionOrigen:'decision',auditor:'auditor',motivoOrigen:'reason',observaciones:'comment',estadoOrigen:'state'}))result[key]=creation[column];
    const links=headers.map(normalized).flatMap((name,index)=>name==='link'?[index]:[]);if(links.length===1)result.referencia=links[0];
    return result;
  }
  const names = headers.map(normalized);
  const mapping = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, uniqueColumn(names, values)]));
  if (mapping.externo < 0 && isCorrectionExport(names)) {
    for (const [key, name] of Object.entries(correctionColumns)) {
      if (mapping[key] < 0) mapping[key] = uniqueColumn(names, [name]);
    }
  }
  return mapping;
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
  const headers = (matrix[headerRow] || []).map(normalized);
  const correctionExport = isCorrectionExport(headers);
  const checks = ['Check TL', 'Check motivo rechazo TL'].map(label => [label, uniqueColumn(headers, [normalized(label)])]);
  if (correctionExport && checks.some(([, index]) => index < 0)) {
    throw Error(name + ' · El archivo debe incluir una columna Check TL y una columna Check motivo rechazo TL.');
  }
  const creation=creationColumns(matrix[headerRow] || []);
  const required = ['idMeli', 'resultado'];
  if (!composite) required.push('externo');
  if (composite) required.push('fecha', 'flujo', 'cdm', 'producto', 'item', 'variante');
  const missing = required.filter(key => mapping[key] < 0).map(key => labels[key]);
  if (missing.length) throw Error(name + ' · Completá el mapeo de: ' + missing.join(', ') + '.');
  if (mapping.fecha < 0 && mapping.periodo < 0 && !defaultPeriod) throw Error(name + ' · Mapeá fecha o período, o indicá un mes de referencia.');
  return matrix.slice(headerRow + 1).flatMap((cells, index) => {
    if (!cells.some(cell => valueOf(cell))) return [];
    const row = {hoja:name, fila:headerRow + index + 2};
    for (const key of Object.keys(labels)) {
      const cell = cells[mapping[key]];
      row[key] = key === 'fecha' ? auditDate(cell, serialDate) : valueOf(cell);
    }
    if (correctionExport) {
      row.flujo = auditSourceFlow(row) || 'SDC';
      const failedChecks = checks.filter(([, index]) => normalized(cells[index]) !== 'ok');
      if (!failedChecks.length) row.resultado = 'null';
      else if (!row.resultado || normalized(row.resultado) === 'null') {
        row.resultado = failedChecks.map(([label, index]) => label + ' (' + (valueOf(cells[index]) || 'sin valor') + ')').join(' · ');
      }
    }
    if(creation){
      const suggestion=valueOf(cells[creation.suggestion]),attribute=valueOf(cells[creation.attribute]);
      row.flujo='SCP';row.tipo='SCP · '+attribute;row.cdm=suggestion;
      row.externo=suggestion&&attribute&&row.fecha&&row.idMeli?'scp:'+JSON.stringify([suggestion,attribute,row.fecha,row.idMeli]):'';
      const failed=[['Check TL',creation.check],['Check motivo TL',creation.reasonCheck]].filter(([,index])=>normalized(cells[index])!=='ok');
      if(!failed.length)row.resultado='null';
      else if(!row.resultado||normalized(row.resultado)==='null')row.resultado='Acción correcta no informada · '+failed.map(([label,index])=>label+' ('+(valueOf(cells[index])||'sin valor')+')').join(' · ');
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
