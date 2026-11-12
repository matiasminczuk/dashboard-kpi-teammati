const assignmentFields = ['colaboradorUid','colaboradorIdMeli','nombreColaborador','equipo','tlUid','nombreTL','incidencia'];
const clean = value => String(value ?? '').trim();
const fold = value => clean(value).toLowerCase();
const noAuditError = row => fold(row.resultado) === 'null';
const reviewStates = ['pendiente_colaborador','pendiente_tl','pendiente_pm','cerrada_aprobada','cerrada_rechazada'];
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(JSON.stringify(value))
)), byte => byte.toString(16).padStart(2,'0')).join('');
const pages = (items, size) => Array.from({length:Math.ceil(items.length / size)}, (_, index) =>
  items.slice(index * size, (index + 1) * size));

export function assignAudit(identifier, profiles, selectedUid, selectedLead, kpis = new Map()) {
  const catalog = [...profiles].filter(([,profile]) => profile.rol === 'catalogador' && clean(profile.idMeli));
  const eligible = catalog.filter(([,profile]) => clean(profile.equipo));
  const matches = eligible.filter(([,profile]) => [
    profile.idMeli, profile.usuario, profile.username, profile.nombre, profile.nombreCompleto, profile.email?.split?.('@')[0], profile.correo?.split?.('@')[0]
  ].some(value => fold(value) === fold(identifier)));
  if (!selectedUid) {
    const kpiMatches = [...kpis].filter(([id,p]) =>
      [id,p.idMeli,p.nombre,p.usuario,p.username].some(value => fold(value) === fold(identifier)));
    const ids = new Set([...kpiMatches.map(([id]) => id),...matches.map(([,p]) => clean(p.idMeli))]);
    if (ids.size > 1) return {incidencia:'Identificador asociado a varios ID MELI'};
    if (kpiMatches.length === 1) {
      const [id,kpi] = kpiMatches[0];
      const accounts = catalog.filter(([,p]) => clean(p.idMeli) === id);
      const leads = [...profiles].filter(([,p]) => p.rol === 'tl' && p.equipo === kpi.equipo);
      if (accounts.length > 1 || accounts.some(([,p]) => clean(p.equipo) && p.equipo !== kpi.equipo)) {
        return {incidencia:'La cuenta y el registro de KPI requieren revisión'};
      }
      if (!clean(kpi.equipo) || leads.length !== 1) return {incidencia:'El equipo no tiene un TL único verificado'};
      return {colaboradorUid:accounts[0]?.[1].equipo === kpi.equipo ? accounts[0][0] : null,colaboradorIdMeli:id,
        nombreColaborador:clean(kpi.nombre).slice(0,150) || null,equipo:kpi.equipo,
        tlUid:leads[0][0],nombreTL:clean(leads[0][1].nombre).slice(0,150) || null,incidencia:null};
    }
  }
  const recipient = selectedUid ? eligible.find(([uid]) => uid === selectedUid) : matches.length === 1 ? matches[0] : null;
  if (!recipient) return {incidencia:matches.length > 1 ? 'Identificador asociado a varias cuentas' : 'Identificador sin cuenta verificada'};
  const [uid,profile] = recipient;
  const leads = [...profiles].filter(([,person]) => person.rol === 'tl' && person.equipo === profile.equipo);
  const lead = selectedLead ? leads.find(([uid]) => uid === selectedLead) : leads.length === 1 ? leads[0] : null;
  if (!lead) return {incidencia:leads.length > 1 ? 'El equipo tiene varios TL' : 'El equipo no tiene TL verificado'};
  const name = p => clean(p.nombre || p.nombreCompleto || p.usuario).slice(0,150) || null;
  return {colaboradorUid:uid,colaboradorIdMeli:profile.idMeli,nombreColaborador:name(profile),equipo:profile.equipo,
    tlUid:lead[0],nombreTL:name(lead[1]),incidencia:null};
}

function normalize(input) {
  const limits = {
    externo:400,idMeli:100,fecha:10,periodo:7,tipo:120,flujo:120,resultado:1000,observaciones:2500,hoja:150,
    auditor:120,cdm:100,producto:100,item:100,variante:100,comentarioOrigen:2500,referencia:500,
    decisionOrigen:150,estadoOrigen:150,motivoOrigen:2500
  };
  const row = {};
  for (const [key,limit] of Object.entries(limits)) {
    const value = clean(input[key]);
    if (value.length > limit) throw Error('Campo demasiado largo: ' + key);
    row[key] = value;
  }
  if (!row.externo || !row.idMeli || !row.resultado) throw Error('Falta ID de auditoría, colaborador o resultado.');
  if (row.fecha) {
    const date = new Date(row.fecha + 'T00:00:00Z');
    if (!Number.isFinite(+date) || date.toISOString().slice(0,10) !== row.fecha) throw Error('Fecha inválida.');
  }
  row.periodo ||= row.fecha.slice(0,7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.periodo) || (row.fecha && !row.fecha.startsWith(row.periodo))) {
    throw Error('Período inválido o distinto del mes de la auditoría.');
  }
  return {...row,fila:input.fila};
}

function issue(row, motivo) {
  return {fila:row.fila ?? null,hoja:clean(row.hoja),identificador:clean(row.idMeli),periodo:clean(row.periodo),motivo};
}

export function createSparkAudits(api) {
  const {db,collection,doc,getDocs,query,where,documentId,runTransaction,serverTimestamp,currentUid,currentMeli,currentRole} = api;
  const audits = collection(db,'auditorias');
  const roster = async path => new Map((await getDocs(collection(db,path))).docs.map(item => [item.id,item.data()]));
  let pending;
  async function importFile({archivo,filas,confirmar,onProgress}, uid) {
    if (!confirmar) {
      pending = undefined;
      if (!filas.length || filas.length > 5000) throw Error('Seleccioná entre 1 y 5.000 filas.');
      const [profiles,kpis] = await Promise.all([roster('usuarios'),roster('kpis')]);
      const groups = new Map(), rejected = [], duplicates = [];
      for (const source of filas) {
        try {
          const row = normalize(source);
          if (!groups.has(row.externo)) groups.set(row.externo,[]);
          groups.get(row.externo).push(row);
        } catch (error) {rejected.push(issue(source,error.message));}
      }
      const entries = (await Promise.all([...groups].map(async ([key,rows]) => {
        const comparable = ({fila,hoja,...rest}) => JSON.stringify(rest);
        if (new Set(rows.map(comparable)).size > 1) {
          rejected.push(...rows.map(row => issue(row,'Clave repetida con datos distintos')));
          return null;
        }
        duplicates.push(...rows.slice(1).map(row => issue(row,'Fila repetida')));
        return {id:await digest(key),row:rows[0],assigned:assignAudit(rows[0].idMeli,profiles,undefined,undefined,kpis)};
      }))).filter(Boolean);
      const id = await digest([archivo,filas]);
      const prior = new Map();
      for (const group of pages(pages(entries,30),5)) {
        const snapshots = await Promise.all(group.map(page => getDocs(query(audits,where(documentId(),'in',page.map(entry => entry.id))))));
        for (const snapshot of snapshots) for (const item of snapshot.docs) prior.set(item.id,item.data());
      }
      const result = {validas:[],sinError:[],incidencias:[],duplicadas:[...duplicates],rechazadas:rejected};
      for (const {id:rowId,row,assigned} of entries) {
        const saved = prior.get(rowId);
        if (saved && saved.importacionId !== id) result.duplicadas.push(issue(row,'Auditoría ya registrada'));
        else if (noAuditError(row)) result.sinError.push(issue(row));
        else if (assigned.incidencia) result.incidencias.push(issue(row,assigned.incidencia));
        else result.validas.push(issue(row));
      }
      if (currentUid() !== uid) throw Error('La sesión cambió.');
      pending = {uid,id,archivo,filas,entries,duplicates,rejected};
      return result;
    }

    const plan = pending;
    if (!plan || plan.uid !== uid || plan.archivo !== archivo || plan.filas !== filas) throw Error('Volvé a validar el archivo.');
    const manifest = doc(db,'importaciones_auditorias',plan.id);
    const completed = await runTransaction(db,async tx => {
      const existing = await tx.get(manifest);
      if (existing.data()?.estado === 'completado') return existing.data().resumen;
      if (!existing.exists()) tx.set(manifest,{archivo,usuario:uid,fecha:serverTimestamp(),estado:'procesando'});
      return null;
    });
    if (completed) return {...completed,repetida:true};
    const summary = {guardadas:0,publicadas:0,pendientes:0,sinError:0,duplicadas:plan.duplicates.length,rechazadas:plan.rejected.length};
    // Lotes pequeños para respetar el límite de lecturas de las reglas de Firestore.
    for (const group of pages(pages(plan.entries,4),5)) {
      const counts = await Promise.allSettled(group.map(page => runTransaction(db,async tx => {
        const previous = await Promise.all(page.map(entry => tx.get(doc(audits,entry.id))));
        return page.map(({id,row,assigned},index) => {
          const saved = previous[index].data();
          if (saved) return saved.importacionId === plan.id ?
            (saved.estado === 'sin_error' ? 'sinError' : saved.estado === 'sin_asignar' ? 'pendientes' : 'publicadas') : 'duplicadas';
          const withoutError = noAuditError(row);
          const isPending = Boolean(assigned.incidencia);
          tx.set(doc(audits,id),{...row,...assigned,importacionId:plan.id,cargadaPor:uid,creadaEn:serverTimestamp(),
            publicadaEn:isPending || withoutError ? null : serverTimestamp(),
            estado:withoutError ? 'sin_error' : isPending ? 'sin_asignar' : 'pendiente_colaborador'});
          return withoutError ? 'sinError' : isPending ? 'pendientes' : 'publicadas';
        });
      })));
      const failed = counts.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      for (const result of counts) for (const key of result.value) summary[key]++;
      onProgress?.(summary.publicadas + summary.pendientes + summary.sinError + summary.duplicadas - plan.duplicates.length,plan.entries.length);
    }
    summary.guardadas = summary.publicadas + summary.pendientes + summary.sinError;
    await runTransaction(db,async tx => {
      const previous = await tx.get(manifest);
      if (previous.data()?.estado === 'procesando') tx.update(manifest,{estado:'completado',completadaEn:serverTimestamp(),resumen:summary,
        incidenciasArchivo:plan.rejected.slice(0,200),duplicadosArchivo:plan.duplicates.slice(0,200)});
    });
    return summary;
  }

  return async (operation, input) => {
    const uid = currentUid();
    if (!uid) throw Error('Iniciá sesión para continuar.');
    if (operation === 'auditoriasImportar') return importFile(input,uid);
    const ref = doc(audits,input.id);
    if (operation === 'auditoriasAsignar') {
      const profiles = await roster('usuarios');
      return runTransaction(db,async tx => {
        const audit = (await tx.get(ref)).data();
        if (audit?.estado !== 'sin_asignar') throw Error('La auditoría ya no está pendiente de asignación.');
        const assigned = assignAudit(audit.idMeli,profiles,input.colaboradorUid,input.tlUid);
        if (assigned.incidencia) throw Error(assigned.incidencia);
        tx.update(ref,{...Object.fromEntries(assignmentFields.map(key => [key,assigned[key]])),
          estado:'pendiente_colaborador',asignacionManual:true,publicadaEn:serverTimestamp(),asignadaPor:uid});
        return {ok:true};
      });
    }
    if (operation !== 'auditoriasActuar') throw Error('Operación desconocida.');
    return runTransaction(db,async tx => {
      const audit = (await tx.get(ref)).data(), accion = input.accion, texto = clean(input.texto);
      const responding = ['responder','devolver'].includes(accion);
      const deciding = ['aprobar','rechazar'].includes(accion);
      const pmReview = deciding && audit?.estado === 'pendiente_pm' && ['pm','admin'].includes(currentRole?.());
      if (texto.length > 3000 || (responding && !texto)) throw Error('Completá la respuesta.');
      if (!(responding && audit?.estado === 'pendiente_colaborador' && ownsAudit(audit,uid,currentMeli?.())) &&
          !(deciding && audit?.estado === 'pendiente_tl' && audit.tlUid === uid) && !pmReview) {
        throw Error('La auditoría cambió de estado o tu cuenta no puede realizar esta acción.');
      }
      const estado = responding ? 'pendiente_tl' : !pmReview ? 'pendiente_pm' :
        accion === 'aprobar' ? 'cerrada_aprobada' : 'cerrada_rechazada';
      tx.update(ref,{estado,[responding ? 'respuesta' : pmReview ? 'decisionPm' : 'decision']:{accion,texto,uid,fecha:serverTimestamp()}});
      return {estado};
    });
  };
}

export function auditReviewTotals(audits) {
  const people = new Map();
  const totals = {revisaron:0,sinRevisar:0,aprobadasTl:0,rechazadasTl:0,pendientesPm:0,aprobadasPm:0,rechazadasPm:0};
  for (const audit of audits) {
    if (!reviewStates.includes(audit.estado)) continue;
    const person = audit.colaboradorIdMeli || audit.colaboradorUid;
    if (person) people.set(String(person),(people.get(String(person)) ?? true) && Boolean(audit.respuesta));
    if (audit.decision?.accion === 'aprobar') totals.aprobadasTl++;
    if (audit.decision?.accion === 'rechazar') totals.rechazadasTl++;
    if (audit.estado === 'pendiente_pm') totals.pendientesPm++;
    if (audit.estado === 'cerrada_aprobada') totals.aprobadasPm += Number(Boolean(audit.decisionPm));
    if (audit.estado === 'cerrada_rechazada') totals.rechazadasPm += Number(Boolean(audit.decisionPm));
  }
  for (const reviewed of people.values()) totals[reviewed ? 'revisaron' : 'sinRevisar']++;
  return totals;
}

export function ownsAudit(audit, uid, idMeli) {
  return audit.colaboradorUid === uid ||
    (audit.colaboradorUid === null && Boolean(idMeli) && audit.colaboradorIdMeli === String(idMeli));
}

export function auditScope(api,profile,global = false) {
  const {db,collection,query,where} = api, base = collection(db,'auditorias');
  if (global) return [base];
  if (profile.role === 'tl' && profile.team) return [query(base,where('equipo','==',profile.team))];
  if (profile.role !== 'catalogador') return [];
  const visible = where('estado','in',reviewStates);
  const targets = [query(base,where('colaboradorUid','==',profile.uid),visible)];
  if (profile.idMeli) targets.push(query(base,where('colaboradorUid','==',null),where('colaboradorIdMeli','==',String(profile.idMeli)),visible));
  return targets;
}

export function watchAuditScope(api,profile,watch,next,fail,global = false) {
  const snapshots = new Map();
  const targets = auditScope(api,profile,global);
  return targets.map((target,index) => watch(target,snapshot => {
    snapshots.set(index,snapshot.docs);
    if (snapshots.size === targets.length) next({docs:[...snapshots.values()].flat()});
  },fail));
}

export function observeSparkNotices(api, profile, watch, onChange) {
  const {db,collection,doc,query,where,orderBy,limit} = api;
  const sources = new Map();
  const timestampKey = value => value ? value.seconds + '-' + value.nanoseconds : '';
  const item = (id,tipo,titulo,mensaje,destino,creadoEn,auditoriaId=null) =>
    ({id,tipo,titulo,mensaje,destino,creadoEn,auditoriaId});
  const add = (source,target,read,observe = watch) => {
    let sequence = 0;
    const stop = observe(target,async snapshot => {
      const current = ++sequence;
      try {
        const entries = await read(snapshot);
        if (current !== sequence) return;
        sources.set(source,entries);
        onChange([...sources.values()].flat());
      } catch (error) {console.warn('No se pudo preparar el aviso',source,error.code || error.message);}
    }, () => {});
    return () => {sequence++;stop();};
  };
  const stops = [];
  const role = profile.role;
  const pm = ['pm','admin'].includes(role);
  const watchAudits = (_target,next,fail) => {
    if (pm) return watch(query(collection(db,'auditorias'),where('estado','==','pendiente_pm')),next,fail);
    const listeners = watchAuditScope(api,profile,watch,next,fail);
    return () => listeners.forEach(stop => stop());
  };
  if (role === 'catalogador' || role === 'tl' || pm) stops.push(add('audits',null,snapshot => {
    const messages = [], groups = new Map();
    for (const record of snapshot.docs) {
      const audit = record.data();
      if (audit.estado === 'sin_error') continue;
      if (pm) {
        if (audit.estado === 'pendiente_pm' && audit.decision?.fecha) messages.push(item('revision-pm-'+record.id,
          'auditoria_revision_pm','Auditoría pendiente del PM','El TL registró su decisión. Falta la revisión final.',
          'auditorias',audit.decision.fecha,record.id));
        continue;
      }
      if (role === 'tl') {
        if (audit.tlUid === profile.uid && audit.respuesta?.fecha) messages.push(item('respuesta-'+record.id,'auditoria_respuesta',
          audit.estado === 'pendiente_tl' ? 'Auditoría pendiente de decisión' : 'Respuesta de auditoría',
          'Un colaborador respondió una auditoría.','auditorias',audit.respuesta.fecha,record.id));
        continue;
      }
      if (audit.publicadaEn) {
        const key = audit.asignacionManual ? record.id : audit.importacionId || record.id;
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push(record);
      }
      const final = audit.decisionPm || (audit.estado.startsWith('cerrada_') ? audit.decision : null);
      if (final?.fecha) messages.push(item('cierre-'+record.id,'auditoria_cierre','Auditoría cerrada',
        final.accion === 'aprobar' ? 'Tu auditoría se cerró con una aprobación.' : 'Tu auditoría se cerró con un rechazo.',
        'auditorias',final.fecha,record.id));
    }
    for (const [key,records] of groups) {
      const single = records.length === 1;
      messages.push(item('nueva-'+key,'auditoria_nueva',single ? 'Nueva auditoría' : 'Nuevas auditorías',
        single ? 'Tenés una nueva auditoría disponible para revisar.' : 'Tenés '+records.length+' nuevas auditorías disponibles para revisar.',
        'auditorias',records[0].data().publicadaEn,single ? records[0].id : null));
    }
    return messages;
  },watchAudits));
  if (profile.global) {
    stops.push(add('reports',query(collection(db,'importaciones_auditorias'),orderBy('fecha','desc'),limit(30)),snapshot =>
      snapshot.docs.flatMap(record => {
        const data = record.data();
        if (!data.resumen?.pendientes && !data.resumen?.rechazadas) return [];
        return [item('incidencias-'+record.id,'auditoria_incidencias','Importación de auditorías con incidencias',
          'Hay filas rechazadas o auditorías que requieren asignación.','auditorias',data.completadaEn || data.fecha)];
      })));
    const types = {productividad:['Productividad','productividad'],holds:['Holds','holds'],
      gestion:['Finalizadas','finalizadas'],calidad:['Calidad','calidad'],kpi_publicacion:['Indicadores','productividad']};
    stops.push(add('imports',query(collection(db,'importaciones'),orderBy('fecha','desc'),limit(40)),snapshot =>
      snapshot.docs.flatMap(record => {
        const data = record.data(), type = types[data.tipo];
        if (!type || data.estado !== 'completado' || !data.notificar) return [];
        const published = ['calidad','kpi_publicacion'].includes(data.tipo);
        return [item('operacion-'+record.id,data.tipo,published ? type[0]+' publicados' : 'Base de '+type[0]+' cargada',
          published ? 'Ya se pueden consultar los indicadores.' : 'La base quedó guardada. Los indicadores quedan pendientes de publicación.',
          type[1],data.fecha)];
      })));
    stops.push(add('quality-loads',query(collection(db,'bases_calidad'),orderBy('fecha','desc'),limit(20)),snapshot =>
      snapshot.docs.flatMap(record => {
        const data = record.data();
        if (data.estado !== 'completado' || !data.notificar) return [];
        return [item('carga-calidad-'+record.id,'calidad_carga','Base de Calidad cargada',
          'El archivo quedó guardado. La publicación de resultados se informa por separado.','calidad',data.fecha)];
      })));
  }
  const personal = role === 'catalogador' && profile.idMeli;
  const team = role === 'tl' && profile.team && !profile.global;
  if (personal || team) {
    const scope = path => personal ? doc(db,path,profile.idMeli) : query(collection(db,path),where('equipo','==',profile.team));
    const dataFrom = snapshot => (personal ? [snapshot] : snapshot.docs).flatMap(record => {
      const data = record.data();
      return data?.publicadoEn ? [{id:record.id,data}] : [];
    });
    const latestDate = entries => entries.reduce((latest,{data}) =>
      !latest || data.publicadoEn.toMillis() > latest.toMillis() ? data.publicadoEn : latest,null);
    stops.push(add('kpi',scope('kpi_publicados'),async snapshot => {
      const entries = dataFrom(snapshot);
      if (!entries.length) return [];
      const sections = [['productividad','tareas','Productividad publicada'],['holds','holds','Holds publicados'],
        ['finalizadas','gestion','Finalizadas publicadas']];
      return (await Promise.all(sections.map(async ([destination,field,title]) => {
        if (destination !== 'productividad' && !entries.some(({data}) => data[field]?.length)) return null;
        const versions = await Promise.all(entries.map(async ({id,data}) =>
          [id,data.notificacionSecciones?.[destination] || await digest(data[field] || [])]));
        const version = await digest(versions.sort(([a],[b]) => a.localeCompare(b)));
        return item('publicacion-'+destination+'-'+version,destination,title,
          'Ya podés consultar los indicadores actualizados.',destination,latestDate(entries));
      }))).filter(Boolean);
    }));
    stops.push(add('quality',scope('calidad_publicada'),snapshot => {
      const date = latestDate(dataFrom(snapshot));
      return date ? [item('publicacion-calidad-'+timestampKey(date),'calidad','Calidad publicada',
        'Ya podés consultar los indicadores actualizados.','calidad',date)] : [];
    }));
  }
  for (const [id,destination] of [['objetivo','calidad'],['objetivos_flujo','calidad'],['productividad','productividad']]) {
    stops.push(add('meta-'+id,doc(db,'calidad_config',id),snapshot => {
      const date = snapshot.data()?.actualizadoEn;
      return date ? [item('meta-'+id+'-'+timestampKey(date),'meta','Objetivos actualizados',
        'Se actualizaron los objetivos del dashboard.',destination,date)] : [];
    }));
  }
  return stops;
}
