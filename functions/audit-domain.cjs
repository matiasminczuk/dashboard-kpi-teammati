const {createHash} = require('node:crypto');

const OWNER = 'zzCZDpLLzvaGpxe3zuqAp2sVtB42';
const digest = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && Object.getPrototypeOf(item) === Object.prototype ?
    Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item)).digest('hex');

function access(uid, profiles, grants) {
  const profile = profiles.get(uid);
  const superAdmin = candidate => {
    const grant = grants.get(candidate);
    return profiles.get(candidate)?.rol === 'tl' && grant?.activo === true &&
      grant.nivel === 'superadmin' && grant.otorgadoPor === OWNER;
  };
  const grant = grants.get(uid);
  const global = ['pm', 'admin'].includes(profile?.rol) || superAdmin(uid) ||
    (profile?.rol === 'tl' && grant?.activo === true && grant.nivel === 'delegado' &&
      (grant.otorgadoPor === OWNER || superAdmin(grant.otorgadoPor)));
  return {...profile, global};
}

function assignment(idMeli, profiles, collaboratorUid, tlUid) {
  const eligible = [...profiles].filter(([, p]) => p.rol === 'catalogador' &&
    String(p.idMeli ?? '').trim() && typeof p.equipo === 'string' && p.equipo.trim());
  const emailUser = value => typeof value === 'string' && value.includes('@') ? value.split('@')[0] : '';
  const matches = eligible.filter(([, p]) => [p.idMeli, p.usuario, p.username, emailUser(p.email), emailUser(p.correo)]
    .some(value => typeof value !== 'object' && String(value ?? '').trim().toLowerCase() === idMeli.toLowerCase()));
  const chosen = collaboratorUid ? eligible.find(([uid]) => uid === collaboratorUid) :
    matches.length === 1 ? matches[0] : null;
  if (!chosen) return {incidencia: matches.length > 1 ? 'ID MELI asociado a varias cuentas' : 'ID MELI sin cuenta y equipo verificados'};
  const [uid, profile] = chosen;
  const leads = [...profiles].filter(([, p]) => p.rol === 'tl' && p.equipo === profile.equipo);
  const lead = tlUid ? leads.find(([candidate]) => candidate === tlUid) : leads.length === 1 ? leads[0] : null;
  if (!lead) return {incidencia: leads.length > 1 ? 'El equipo tiene varios TL' : 'El equipo no tiene TL asignado'};
  const name = person => [person.nombre, person.nombreCompleto, person.usuario]
    .find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 150) || null;
  return {colaboradorUid: uid, colaboradorIdMeli: String(profile.idMeli).trim(), nombreColaborador: name(profile),
    equipo: profile.equipo, tlUid: lead[0], nombreTL: name(lead[1]), incidencia: null};
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function normalizeRow(input) {
  const row = {};
  for (const [key, limit] of Object.entries({
    externo: 400, idMeli: 100, fecha: 10, periodo: 7, tipo: 120, flujo: 120,
    resultado: 1000, observaciones: 2500, hoja: 150, auditor: 120, cdm: 100,
    producto: 100, item: 100, variante: 100, comentarioOrigen: 2500, referencia: 500,
    decisionOrigen: 150, estadoOrigen: 150, motivoOrigen: 2500
  })) {
    const value = input?.[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw Error('Valor inválido en ' + key);
    row[key] = value.trim();
  }
  if (!row.externo || !row.idMeli || !row.resultado) throw Error('Se requieren ID de auditoría, ID MELI y resultado');
  if (row.fecha && !validDate(row.fecha)) throw Error('Fecha inválida. Usá AAAA-MM-DD');
  if (row.periodo && !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.periodo)) throw Error('Período inválido. Usá AAAA-MM');
  if (row.fecha && row.periodo && !row.fecha.startsWith(row.periodo)) throw Error('La fecha y el período no coinciden');
  row.periodo ||= row.fecha.slice(0, 7);
  if (!row.periodo) throw Error('Indicá una fecha o un período');
  if (!Number.isSafeInteger(input.fila) || input.fila < 1) throw Error('Número de fila inválido');
  row.fila = input.fila;
  return row;
}

function transition(audit, uid, profile, action) {
  if (['responder', 'devolver'].includes(action) && profile.rol === 'catalogador' &&
      audit.colaboradorUid === uid && audit.estado === 'pendiente_colaborador') return 'pendiente_tl';
  if (['aprobar', 'rechazar'].includes(action) && profile.rol === 'tl' && audit.equipo === profile.equipo &&
      audit.tlUid === uid && audit.estado === 'pendiente_tl') {
    return action === 'aprobar' ? 'cerrada_aprobada' : 'cerrada_rechazada';
  }
  return null;
}

module.exports = {access, assignment, digest, normalizeRow, transition};
