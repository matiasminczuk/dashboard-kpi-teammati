const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onDocumentCreated, onDocumentUpdated, onDocumentWritten} = require('firebase-functions/v2/firestore');
const {access, assignment, digest, normalizeRow, transition} = require('./audit-domain.cjs');

initializeApp();
const db = getFirestore();
const timestamp = () => FieldValue.serverTimestamp();
const pathId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  !value.includes('/') && !['.', '..'].includes(value);
const keyed = snapshot => new Map(snapshot.docs.map(item => [item.id, item.data()]));
const roster = async () => {
  const [profiles, grants] = await Promise.all(['usuarios', 'permisos_dashboard'].map(name => db.collection(name).get()));
  return [keyed(profiles), keyed(grants)];
};
const profileRef = uid => db.collection('usuarios').doc(uid);
const auditRef = id => db.collection('auditorias').doc(id);

function notice(uid, event, type, title, message, destination, auditId = null) {
  return {
    ref: profileRef(uid).collection('notificaciones').doc(digest([event, type])),
    data: {destinatario: uid, evento: event, tipo: type, titulo: title, mensaje: message,
      destino: destination, auditoriaId: auditId, creadoEn: timestamp(), leidaEn: null}
  };
}

async function deliver(items) {
  if (!items.length) return;
  const writer = db.bulkWriter();
  writer.onWriteError(error => error.code !== 6 && error.failedAttempts < 4);
  const writes = items.map(({ref, data}) => writer.create(ref, data).catch(error => {
    if (error.code !== 6) throw error;
  }));
  await Promise.all([writer.close(), ...writes]);
}

function history(transaction, ref, id, type, uid, details = {}) {
  transaction.create(ref.collection('historial').doc(id), {tipo: type, uid, fecha: timestamp(), ...details});
}

function publication(transaction, ref, uid, assigned) {
  history(transaction, ref, '02-asignada', 'asignada', uid, assigned);
  history(transaction, ref, '03-publicada', 'publicada', uid);
}

function authorized(request, profiles, grants) {
  const uid = request.auth?.uid;
  if (!uid || !profiles.has(uid)) throw new HttpsError('unauthenticated', 'Iniciá sesión con un perfil habilitado.');
  if (!access(uid, profiles, grants).global) throw new HttpsError('permission-denied', 'Tu perfil no puede administrar auditorías.');
  return uid;
}

function analyze(input, profiles) {
  if (!Array.isArray(input) || !input.length || input.length > 5000) {
    throw new HttpsError('invalid-argument', 'Seleccioná entre 1 y 5.000 filas por importación.');
  }
  const rows = [], rejected = [], groups = new Map();
  for (const raw of input) {
    try {
      const row = normalizeRow(raw);
      const id = digest(row.externo);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
    } catch (error) {
      rejected.push({fila: Number.isSafeInteger(raw?.fila) ? raw.fila : null, hoja: String(raw?.hoja ?? '').slice(0, 150), motivo: error.message});
    }
  }
  const duplicates = [];
  for (const [id, versions] of groups) {
    const comparable = ({fila, hoja, ...value}) => digest(value);
    if (new Set(versions.map(comparable)).size > 1) {
      for (const {fila, hoja} of versions) rejected.push({fila, hoja, motivo: 'Clave repetida con datos distintos'});
      continue;
    }
    const [row, ...repeat] = versions;
    for (const {fila, hoja} of repeat) duplicates.push({fila, hoja, motivo: 'Fila repetida'});
    rows.push({id, row, assigned: assignment(row.idMeli, profiles)});
  }
  return {rows, rejected, duplicates};
}

exports.auditoriasImportar = onCall({timeoutSeconds: 300}, async request => {
  const [profiles, grants] = await rosterFor(request);
  const uid = authorized(request, profiles, grants);
  const {filas, archivo, confirmar} = request.data ?? {};
  if (typeof archivo !== 'string' || !archivo.trim() || archivo.length > 250) throw new HttpsError('invalid-argument', 'Nombre de archivo inválido.');
  if (typeof confirmar !== 'boolean') throw new HttpsError('invalid-argument', 'Indicá si querés validar o confirmar.');
  const {rows, rejected, duplicates} = analyze(filas, profiles);
  const id = digest([archivo, filas]);
  const manifest = db.collection('importaciones_auditorias').doc(id);
  const preview = {validas: [], rechazadas: rejected, duplicadas: duplicates, incidencias: [], importacionId: id};

  if (!confirmar) {
    for (let i = 0; i < rows.length; i += 75) {
      const part = rows.slice(i, i + 75);
      const existing = await db.getAll(...part.map(item => auditRef(item.id)));
      part.forEach(({row, assigned}, index) => {
        const item = {fila: row.fila, hoja: row.hoja, identificador: row.idMeli, periodo: row.periodo};
        if (existing[index].exists) duplicates.push({...item, motivo: 'Auditoría ya registrada'});
        else if (assigned.incidencia) preview.incidencias.push({...item, motivo: assigned.incidencia});
        else preview.validas.push(item);
      });
    }
    return preview;
  }

  if (!rows.length) throw new HttpsError('failed-precondition', 'La importación no contiene filas válidas.');
  const completed = await db.runTransaction(async transaction => {
    const previous = await transaction.get(manifest);
    if (previous.data()?.estado === 'completado') return previous.data().resumen;
    if (!previous.exists) transaction.create(manifest, {archivo, usuario: uid, fecha: timestamp(), estado: 'procesando'});
    else if (previous.data().estado === 'error') transaction.update(manifest, {estado: 'procesando'});
    return null;
  });
  if (completed) return {...completed, repetida: true, importacionId: id};

  try {
    return await saveImport(manifest, id, uid, rows, duplicates, rejected);
  } catch (error) {
    console.error('Error de importación de auditorías', id, error.code);
    await db.runTransaction(async transaction => {
      const saved = await transaction.get(manifest);
      if (saved.data()?.estado === 'procesando') transaction.update(manifest, {estado:'error', falloEn:timestamp()});
    });
    throw new HttpsError('internal', 'No se completó la importación.');
  }
});

async function saveImport(manifest, id, uid, rows, duplicates, rejected) {
  let guardadas = 0, publicadas = 0, pendientes = 0, yaRegistradas = 0;
  for (let i = 0; i < rows.length; i += 75) {
    const part = rows.slice(i, i + 75);
    const counts = await db.runTransaction(async transaction => {
      const refs = part.map(item => auditRef(item.id));
      const previous = await transaction.getAll(...refs);
      const tally = {guardadas: 0, publicadas: 0, pendientes: 0, yaRegistradas: 0};
      part.forEach(({row, assigned}, index) => {
        const saved = previous[index].data();
        if (saved?.importacionId === id) {
          tally.guardadas++;
          tally[saved.estado === 'sin_asignar' ? 'pendientes' : 'publicadas']++;
          return;
        }
        if (saved) {tally.yaRegistradas++;return;}
        const ref = refs[index], pending = Boolean(assigned.incidencia);
        transaction.create(ref, {...row, ...assigned, importacionId: id, cargadaPor: uid,
          creadaEn: timestamp(), publicadaEn: pending ? null : timestamp(),
          estado: pending ? 'sin_asignar' : 'pendiente_colaborador'});
        history(transaction, ref, '01-importada', 'importada', uid, pending ? {incidencia:assigned.incidencia} : {});
        if (!pending) publication(transaction, ref, uid, assigned);
        tally.guardadas++;
        tally[pending ? 'pendientes' : 'publicadas']++;
      });
      return tally;
    });
    guardadas += counts.guardadas;
    publicadas += counts.publicadas;
    pendientes += counts.pendientes;
    yaRegistradas += counts.yaRegistradas;
  }
  const summary = {guardadas, publicadas, pendientes, duplicadas: duplicates.length + yaRegistradas, rechazadas: rejected.length};
  await db.runTransaction(async transaction => {
    const previous = await transaction.get(manifest);
    if (previous.data()?.estado !== 'completado') {
      transaction.update(manifest, {estado: 'completado', completadaEn: timestamp(), resumen: summary,
        incidenciasArchivo: rejected.slice(0, 200), duplicadosArchivo: duplicates.slice(0, 200)});
    }
  });
  return {...summary, importacionId: id};
}

async function rosterFor(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
  const grantRef = id => db.collection('permisos_dashboard').doc(id);
  const [profile, grant] = await db.getAll(profileRef(uid),grantRef(uid));
  const profiles = new Map([[uid,profile.data()]]), grants = new Map([[uid,grant.data()]]);
  const issuer = grant.data()?.otorgadoPor;
  if (grant.data()?.nivel === 'delegado' && pathId(issuer) && issuer !== uid) {
    const [issuerProfile, issuerGrant] = await db.getAll(profileRef(issuer),grantRef(issuer));
    profiles.set(issuer,issuerProfile.data());
    grants.set(issuer,issuerGrant.data());
  }
  authorized(request,profiles,grants);
  return roster();
}

exports.auditoriasAsignar = onCall(async request => {
  const [profiles, grants] = await rosterFor(request);
  const uid = authorized(request, profiles, grants);
  const {id, colaboradorUid, tlUid} = request.data ?? {};
  if (!pathId(id) || !pathId(colaboradorUid) || !pathId(tlUid)) throw new HttpsError('invalid-argument', 'Seleccioná un colaborador y un TL.');
  const ref = auditRef(id);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref), audit = snapshot.data();
    if (audit?.estado !== 'sin_asignar') throw new HttpsError('failed-precondition', 'La auditoría ya no está pendiente de asignación.');
    const assigned = assignment(audit.idMeli, profiles, colaboradorUid, tlUid);
    if (assigned.incidencia) throw new HttpsError('failed-precondition', assigned.incidencia);
    transaction.update(ref, {...assigned, estado: 'pendiente_colaborador', publicadaEn: timestamp(), asignacionManual: true});
    publication(transaction, ref, uid, assigned);
    const item = newAuditNotice(colaboradorUid, id, id);
    transaction.create(item.ref, item.data);
  });
  return {ok: true};
});

exports.auditoriasActuar = onCall(async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
  const {id, accion, texto} = request.data ?? {};
  const response = ['responder', 'devolver'].includes(accion);
  if (!pathId(id) || !['responder', 'devolver', 'aprobar', 'rechazar'].includes(accion) ||
      typeof texto !== 'string' || texto.length > 3000 || (response && !texto.trim())) {
    throw new HttpsError('invalid-argument', 'Completá la acción y el texto requerido.');
  }
  return db.runTransaction(async transaction => {
    const ref = auditRef(id);
    const [snapshot, actor] = await transaction.getAll(ref, profileRef(uid));
    const audit = snapshot.data(), profile = actor.data();
    if (!audit || !profile) throw new HttpsError('permission-denied', 'Auditoría no disponible para esta cuenta.');
    const estado = transition(audit, uid, profile, accion);
    if (!estado) throw new HttpsError('failed-precondition', 'La auditoría cambió de estado o tu cuenta no puede realizar esta acción.');
    const recipient = response ? audit.tlUid : audit.colaboradorUid;
    const target = (await transaction.get(profileRef(recipient))).data();
    if (response && (target?.rol !== 'tl' || target.equipo !== audit.equipo)) {
      throw new HttpsError('failed-precondition', 'El TL asignado ya no pertenece al equipo.');
    }
    const entry = {accion, texto: texto.trim(), uid, fecha: timestamp()};
    transaction.update(ref, {estado, [response ? 'respuesta' : 'decision']: entry});
    history(transaction, ref, response ? '04-respuesta' : '05-decision', response ? 'respuesta' : 'decisión', uid, {accion, texto: entry.texto});
    const approved = accion === 'aprobar';
    const item = notice(recipient, id, response ? 'auditoria_respuesta' : 'auditoria_cierre',
      response ? 'Auditoría pendiente de decisión' : 'Auditoría cerrada',
      response ? 'Un colaborador respondió una auditoría y está pendiente de tu decisión.' :
        approved ? 'Tu TL aprobó tu respuesta. La auditoría quedó cerrada.' : 'Tu TL rechazó tu respuesta. La auditoría quedó cerrada.',
      'auditorias', id);
    transaction.create(item.ref, item.data);
    return {estado};
  });
});

function newAuditNotice(uid, event, id, count = 1) {
  return notice(uid, event, 'auditoria_nueva', count === 1 ? 'Nueva auditoría' : 'Nuevas auditorías',
    count === 1 ? 'Tenés una nueva auditoría disponible para revisar.' : 'Tenés ' + count + ' nuevas auditorías disponibles para revisar.',
    'auditorias', id);
}

const trigger = document => ({document, region: 'southamerica-east1', retry: true, timeoutSeconds: 300});
exports.notificarImportacionAuditorias = onDocumentUpdated(trigger('importaciones_auditorias/{id}'), async event => {
  const data = event.data.after.data(), id = event.params.id;
  if (data.estado === 'error' && event.data.before.data().estado !== 'error') {
    await deliver([notice(data.usuario, id, 'auditoria_error', 'Importación de auditorías incompleta',
      'La importación se interrumpió. Revisá el resultado y reintentá el mismo archivo.', 'auditorias')]);
    return;
  }
  if (data.estado !== 'completado' || event.data.before.data().estado === 'completado') return;
  const snapshots = await db.collection('auditorias').where('importacionId', '==', id).get();
  const byUser = new Map();
  for (const item of snapshots.docs) {
    const {colaboradorUid, asignacionManual} = item.data();
    if (!colaboradorUid || asignacionManual) continue;
    if (!byUser.has(colaboradorUid)) byUser.set(colaboradorUid, []);
    byUser.get(colaboradorUid).push(item.id);
  }
  const messages = [...byUser].map(([uid, ids]) => newAuditNotice(uid, id, ids.length === 1 ? ids[0] : null, ids.length));
  if (data.resumen.pendientes || data.resumen.rechazadas) {
    const profiles = keyed(await db.collection('usuarios').get());
    for (const [uid, profile] of profiles) if (['pm', 'admin'].includes(profile.rol) || uid === data.usuario) {
      messages.push(notice(uid, id, 'auditoria_incidencias', 'Importación de auditorías con incidencias',
        'Hay filas rechazadas o auditorías que requieren una asignación.', 'auditorias'));
    }
  }
  await deliver(messages);
});

async function notifyImport(snapshot, id) {
  const data = snapshot?.data();
  if (!data || data.estado !== 'completado' || data.notificar !== true || !pathId(data.usuario)) return;
  const [profiles, grants] = await roster();
  if (!access(data.usuario, profiles, grants).global) return;
  const types = {
    productividad: ['Productividad', 'productividad'],
    holds: ['Holds', 'holds'],
    gestion: ['Finalizadas', 'finalizadas'],
    calidad: ['Calidad', 'calidad'],
    kpi_publicacion: ['Indicadores del equipo', 'productividad']
  };
  const type = types[data.tipo];
  if (!type || !Array.isArray(data.afectados) || !data.afectados.length) return;
  if (data.tipo === 'kpi_publicacion') {
    await notifyKpiPublication(id, data, profiles);
    return;
  }
  const affected = await verifiedAffected(data);
  if (!affected.size) return;
  const published = data.tipo === 'calidad';
  const teams = new Set();
  const recipients = new Set();
  for (const [uid, profile] of profiles) {
    if (profile.rol !== 'catalogador' || !affected.has(String(profile.idMeli))) continue;
    if (profile.equipo) teams.add(profile.equipo);
    if (published) recipients.add(uid);
  }
  for (const [uid, profile] of profiles) {
    if (uid === data.usuario || ['pm', 'admin'].includes(profile.rol) ||
        (profile.rol === 'tl' && teams.has(profile.equipo))) recipients.add(uid);
  }
  const eventId = data.operacionAviso || id;
  await deliver([...recipients].map(uid => notice(uid, eventId, data.tipo,
    published ? type[0] + ' publicados' : 'Base de ' + type[0] + ' cargada',
    published ? 'Ya podés consultar los indicadores actualizados.' : 'La carga se guardó y está pendiente de publicación de indicadores.',
    type[1])));
}

async function verifiedAffected(data) {
  const refs = new Map();
  for (const id of new Set(data.afectados)) {
    if (!pathId(id)) continue;
    if (data.tipo === 'calidad') refs.set(id, db.collection('calidad_publicada').doc(id));
    else if (pathId(data.testigos?.[id])) refs.set(id, db.collection('kpis').doc(id).collection('registros').doc(data.testigos[id]));
  }
  const keys = [...refs.keys()], verified = new Map();
  for (let start = 0; start < keys.length; start += 100) {
    const slice = keys.slice(start, start + 100);
    const snapshots = await db.getAll(...slice.map(id => refs.get(id)));
    snapshots.forEach((snapshot, index) => {
      const value = snapshot.data(), id = slice[index];
      if (!value) return;
      const expected = data.tipo === 'productividad' ? ['tareas', 'creaciones'] : data.tipo === 'holds' ? ['hold'] : ['gestion'];
      const matches = data.tipo === 'calidad' ? Boolean(data.hash) && Object.values(value.registros || {}).some(record => record.base === data.hash) :
        Boolean(data.operacionAviso) && value.operacionAviso === data.operacionAviso && expected.includes(value.tipo);
      if (matches) verified.set(id,value);
    });
  }
  return verified;
}

const kpiSections = {
  productividad: {field:'tareas', type:'kpi_publicacion', title:'Productividad publicada'},
  holds: {field:'holds', type:'holds_publicados', title:'Holds publicados'},
  finalizadas: {field:'gestion', type:'finalizadas_publicadas', title:'Finalizadas publicadas'}
};

async function publicationChanges(eventId, personId, expectedVersion) {
  const state = db.collection('notificaciones_kpi_estado').doc(personId);
  const receipt = db.collection('notificaciones_kpi_eventos').doc(eventId).collection('fichas').doc(personId);
  const published = db.collection('kpi_publicados').doc(personId);
  return db.runTransaction(async transaction => {
    const [previous, seen, snapshot] = await transaction.getAll(state, receipt, published);
    if (seen.exists) return seen.data();
    const value = snapshot.data();
    if (!expectedVersion || value?.notificacionVersion !== expectedVersion) {
      const result = {destinos:[],equipo:null};
      transaction.create(receipt,result);
      return result;
    }
    const prior = previous.data(), publicationDate = value.publicadoEn;
    if (prior?.publicadoEn && publicationDate?.toMillis && prior.publicadoEn.toMillis() > publicationDate.toMillis()) {
      const result = {destinos:[],equipo:null};
      transaction.create(receipt,result);
      return result;
    }
    const hashes = {}, destinations = [];
    for (const [destination,{field}] of Object.entries(kpiSections)) {
      const records = Array.isArray(value[field]) ? value[field] : [];
      hashes[destination] = digest([value.equipo, records]);
      if (prior?.hashes?.[destination] !== hashes[destination] && (prior || records.length || destination === 'productividad')) {
        destinations.push(destination);
      }
    }
    transaction.set(state,{hashes,publicadoEn:publicationDate?.toMillis ? publicationDate : timestamp()});
    const result = {destinos:destinations,equipo:typeof value.equipo === 'string' ? value.equipo : null};
    transaction.create(receipt,result);
    return result;
  });
}

async function notifyKpiPublication(eventId, data, profiles) {
  const byDestination = new Map(), entries = [...new Set(data.afectados)].filter(pathId);
  for (let i = 0; i < entries.length; i += 30) {
    const page = entries.slice(i,i + 30);
    const changes = await Promise.all(page.map(id => publicationChanges(eventId,id,data.versiones?.[id])));
    changes.forEach(({destinos,equipo},index) => {
      for (const destination of destinos) {
        if (!byDestination.has(destination)) byDestination.set(destination,{people:new Set(),teams:new Set()});
        const scope = byDestination.get(destination);
        scope.people.add(page[index]);
        if (equipo) scope.teams.add(equipo);
      }
    });
  }
  const notices = [];
  for (const [destination,{people,teams}] of byDestination) {
    const {type,title} = kpiSections[destination];
    for (const [uid,profile] of profiles) {
      const eligible = (profile.rol === 'catalogador' && people.has(String(profile.idMeli))) ||
        (profile.rol === 'tl' && teams.has(profile.equipo)) || ['pm','admin'].includes(profile.rol) || uid === data.usuario;
      if (eligible) notices.push(notice(uid,eventId,type,title,'Ya podés consultar los indicadores actualizados.',destination));
    }
  }
  await deliver(notices);
}

exports.notificarImportacionKpi = onDocumentWritten(trigger('importaciones/{id}'), async event => {
  if (!event.data?.after.exists || event.data.before.data()?.notificar === event.data.after.data()?.notificar) return;
  await notifyImport(event.data.after, event.params.id);
});

exports.notificarArchivoCalidad = onDocumentCreated(trigger('bases_calidad/{id}'), async event => {
  const data = event.data?.data();
  if (!data?.notificar || data.estado !== 'completado') return;
  const [profiles, grants] = await roster();
  if (!access(data.usuario, profiles, grants).global) return;
  await deliver([...profiles].filter(([uid, p]) => uid === data.usuario || ['pm', 'admin'].includes(p.rol))
    .map(([uid]) => notice(uid, event.params.id, 'calidad_carga', 'Base de Calidad cargada',
      'El archivo de origen quedó guardado. La publicación de resultados se informa por separado.', 'calidad')));
});

exports.notificarMetas = onDocumentWritten(trigger('calidad_config/{id}'), async event => {
  if (!['objetivo', 'productividad'].includes(event.params.id) || !event.data?.after.exists) return;
  const before = event.data.before.data(), after = event.data.after.data();
  const fields = event.params.id === 'objetivo' ? ['valor'] : ['mixto', 'soporte'];
  if (fields.every(key => before?.[key] === after[key])) return;
  const profiles = keyed(await db.collection('usuarios').get());
  await deliver([...profiles].filter(([, p]) => ['pm', 'admin', 'tl', 'catalogador'].includes(p.rol))
    .map(([uid]) => notice(uid, event.id, 'meta', 'Objetivos actualizados', 'Se actualizaron los objetivos del dashboard.',
      event.params.id === 'objetivo' ? 'calidad' : 'productividad')));
});
