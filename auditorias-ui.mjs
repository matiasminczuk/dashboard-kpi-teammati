import {labels, mapHeaders, mapAuditRows, hasNetkelColumns} from './auditorias-import.mjs';

const states = {
  sin_asignar:'Sin asignar', pendiente_colaborador:'Pendiente del colaborador',
  pendiente_tl:'Pendiente del TL', cerrada_aprobada:'Cerrada · aprobada',
  cerrada_rechazada:'Cerrada · rechazada'
};
const actions = {responder:'Enviar respuesta', devolver:'Devolver al TL', aprobar:'Aprobar y cerrar', rechazar:'Rechazar y cerrar'};
const eventLabels = {productividad:'Productividad', holds:'Holds', gestion:'Finalizadas', calidad:'Calidad',
  calidad_carga:'Calidad', kpi_publicacion:'Productividad', holds_publicados:'Holds',
  finalizadas_publicadas:'Finalizadas', meta:'Objetivos'};
const dateFormat = new Intl.DateTimeFormat('es-AR', {dateStyle:'medium', timeStyle:'short'});
const dateText = value => value?.toDate ? dateFormat.format(value.toDate()) : '—';
const nameOf = (profile, fallback) => profile?.nombre || profile?.nombreCompleto || profile?.usuario || fallback;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, handler, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}
function options(select, values, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...values.map(([value, label]) => new Option(label, value)));
  if (values.some(([value]) => value === previous)) select.value = previous;
}
function lines(container, entries) {
  container.replaceChildren(...entries.map(([label, value]) => {
    const row = element('div');
    row.append(element('dt', label), element('dd', value || '—'));
    return row;
  }));
}
function errorText(error) {
  const code = error.code?.split('/').at(-1);
  if (['permission-denied', 'failed-precondition', 'invalid-argument', 'unauthenticated'].includes(code)) return error.message;
  return 'No se pudo completar la operación. Revisá la conexión y volvé a intentar.';
}

export function setupAudits(api) {
  const $ = id => document.getElementById(id);
  const bell = $('notificationsToggle'), popup = $('notificationsPanel'), unreadCount = $('notificationBadge');
  const auditPanel = $('viewAuditorias'), detail = $('auditDetail'), detailBody = $('auditDetailBody');
  const filter = $('auditFilters'), reports = $('auditReports'), upload = $('auditUploadPanel');
  const sheetSelect = $('auditSheet'), headerInput = $('auditHeaderRow'), mappingArea = $('auditMappings');
  const loadButton = $('auditLoad'), fileInput = $('auditFile'), fileSetup = $('auditFileSetup');
  const status = $('auditUploadStatus'), preview = $('auditPreview');
  let session, listeners = [], audits = [], all = [], unread = [], detailListener, historyListener;
  let inbox, inboxListener, visibleNotices = 100;
  let selectedAudit, history = [], roster = new Map(), sheets = [], fileVersion = 0, busy = false;
  let notificationError = false, onlyUnread = false, listError = false, auditLoading = false, saving = false;
  const format = number => new Intl.NumberFormat('es-AR').format(number);
  const ctx = () => session;
  const auditList = () => {
    const base = api.collection(api.db, 'auditorias');
    if (session.global) return base;
    if (session.role === 'tl' && session.team) return api.query(base, api.where('equipo','==',session.team));
    if (session.role === 'catalogador') return api.query(base, api.where('colaboradorUid','==',session.uid));
    return null;
  };

  function stopDetail() {
    detailListener?.(); historyListener?.(); detailListener = historyListener = undefined;
    selectedAudit = undefined; history = []; detail.hidden = true; detailBody.replaceChildren();
  }
  function closeView() {
    auditPanel.hidden = true;
    stopDetail();
  }
  function stop() {
    session = undefined; ++fileVersion;
    listeners.forEach(unsubscribe => unsubscribe()); listeners = [];
    inboxListener?.(); inboxListener = undefined; inbox = undefined; visibleNotices = 100;
    closeView();
    if (popup.matches(':popover-open')) popup.hidePopover();
    $('notificationControl').hidden = true;
    $('notificationItems').replaceChildren();
    $('notificationStatus').textContent = '';
    unreadCount.hidden = true;
    $('auditRows').replaceChildren();
    reports.replaceChildren();
    roster = new Map(); audits = []; all = []; unread = []; sheets = [];
    notificationError = false; onlyUnread = false; listError = false; auditLoading = false;
    busy = false; saving = false;
    fileInput.value = ''; importBusy(false);
    $('auditReferenceMonth').value = ''; fileSetup.hidden = true; fileSetup.open = false; preview.hidden = true;
    for (const node of [$('auditPreviewResults'),sheetSelect,mappingArea,$('auditSheetPreview')]) node.replaceChildren();
    $('auditSheetInfo').textContent = '';
    status.textContent = '';
  }
  function watch(query, next, fail) {
    const current = ctx();
    return api.onSnapshot(query, snap => {if (ctx() === current) next(snap);}, error => {
      if (ctx() === current) fail(error);
    });
  }
  function start(profile) {
    stop();
    session = profile;
    $('notificationControl').hidden = false;
    reports.hidden = !profile.global;
    filter.querySelectorAll('[data-audit-global]').forEach(node => {node.hidden = !profile.global;});
    $('auditFilterPerson').closest('label').hidden = profile.role === 'catalogador';
    filter.reset();
    inbox = api.collection(api.db, 'usuarios', profile.uid, 'notificaciones');
    watchInbox();
    listeners.push(watch(api.query(inbox, api.where('leidaEn','==',null)), snap => {
      unread = snap.docs; renderNotifications();
    }, () => {notificationError = true; renderNotifications();}));
    renderNotifications();
  }
  function watchInbox() {
    inboxListener?.();
    inboxListener = watch(api.query(inbox, api.orderBy('creadoEn','desc'), api.limit(visibleNotices + 1)), snap => {
      all = snap.docs; notificationError = false; renderNotifications();
    }, () => {notificationError = true; renderNotifications();});
  }
  function listenAudits() {
    if (session.auditListening) return;
    session.auditListening = true;
    const scope = auditList();
    auditLoading = Boolean(scope);
    if (scope) listeners.push(watch(scope, snap => {
      audits = snap.docs.map(doc => ({...doc.data(), id:doc.id}));
      auditLoading = false; listError = false; renderAuditList();
    }, () => {auditLoading = false; listError = true; renderAuditList();}));
    if (!session.global) return;
    const current = ctx();
    api.getDocs(api.collection(api.db,'usuarios')).then(snap => {
      if (ctx() !== current) return;
      roster = new Map(snap.docs.map(item => [item.id,item.data()]));
      renderAuditList();
      if (selectedAudit?.estado === 'sin_asignar') renderDetail(selectedAudit);
    }).catch(() => {});
    listeners.push(watch(api.query(api.collection(api.db,'importaciones_auditorias'), api.orderBy('fecha','desc'), api.limit(30)),
      snap => renderReports(snap.docs), () => {reports.textContent = 'No se pudieron leer las importaciones.';}));
  }

  function openView(id) {
    if (!session) return;
    api.openAuditView();
    auditPanel.hidden = false;
    listenAudits();
    renderAuditList();
    if (id) openDetail(id);
    else {stopDetail(); $('auditTitle').focus(); window.scrollTo(0,0);}
  }

  function renderNotifications() {
    const count = unread.length;
    unreadCount.hidden = count === 0;
    unreadCount.textContent = count > 99 ? '99+' : String(count);
    bell.setAttribute('aria-label', count ? 'Notificaciones · ' + count + ' sin leer' : 'Notificaciones');
    $('notificationCount').textContent = format(count) + ' sin leer';
    $('notificationReadAll').disabled = !count;
    $('notificationsAll').setAttribute('aria-pressed', String(!onlyUnread));
    $('notificationsUnread').setAttribute('aria-pressed', String(onlyUnread));
    const entries = onlyUnread ? [...unread].sort((a,b) => (b.data().creadoEn?.seconds || 0) - (a.data().creadoEn?.seconds || 0)) : all.slice(0,visibleNotices);
    const list = $('notificationItems');
    list.replaceChildren();
    if (!entries.length) list.append(element('p', notificationError ? 'No se pudieron cargar las notificaciones.' :
      onlyUnread ? 'No tenés notificaciones sin leer.' : 'Todavía no tenés notificaciones.', 'audit-empty'));
    for (const doc of entries) {
      const item = doc.data();
      const row = button(undefined, () => visitNotice(doc), 'notification-item');
      if (!item.leidaEn) row.dataset.unread = 'true';
      row.append(element('span', (eventLabels[item.tipo] || 'Auditorías') + ' · ' + (item.leidaEn ? 'Leída' : 'Sin leer'), 'notification-meta'),
        element('strong', item.titulo), element('span', item.mensaje), element('time', dateText(item.creadoEn), 'notification-meta'));
      list.append(row);
    }
    if (!onlyUnread && all.length > visibleNotices) list.append(button('Ver anteriores', event => {
      event.currentTarget.disabled = true;
      visibleNotices += 100;
      watchInbox();
    },'notification-item'));
  }
  async function markRead(entries) {
    for (let i = 0; i < entries.length; i += 350) {
      const batch = api.writeBatch(api.db);
      for (const doc of entries.slice(i, i + 350)) batch.update(doc.ref,{leidaEn:api.serverTimestamp()});
      await batch.commit();
    }
  }
  async function visitNotice(doc) {
    const current = ctx(), item = doc.data();
    if (!item.leidaEn) {
      try {await markRead([doc]);}
      catch {if (ctx() === current) $('notificationStatus').textContent = 'No se pudo marcar la notificación como leída.'; return;}
    }
    if (ctx() !== current) return;
    popup.hidePopover();
    if (item.destino === 'auditorias') openView(item.auditoriaId);
    else api.navigate(item.destino);
  }
  $('notificationsAll').onclick = () => {onlyUnread = false; renderNotifications();};
  $('notificationsUnread').onclick = () => {onlyUnread = true; renderNotifications();};
  $('notificationReadAll').onclick = async () => {
    const current = ctx();
    $('notificationReadAll').disabled = true;
    $('notificationStatus').textContent = '';
    try {await markRead([...unread]);}
    catch {if (ctx() === current) $('notificationStatus').textContent = 'No se pudieron marcar todas como leídas.';}
    finally {if (ctx() === current) $('notificationReadAll').disabled = !unread.length;}
  };
  function positionNotifications() {
    const anchor = bell.getBoundingClientRect();
    const width = Math.min(420,window.innerWidth - 16);
    const right = Math.min(window.innerWidth - width - 8, Math.max(8,window.innerWidth - anchor.right));
    popup.style.setProperty('--notification-top', Math.max(8,Math.min(anchor.bottom + 8, window.innerHeight - 160)) + 'px');
    popup.style.setProperty('--notification-end', right + 'px');
  }
  popup.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    bell.setAttribute('aria-expanded', String(open));
    if (open) positionNotifications();
  });
  window.addEventListener('resize', () => {if (popup.matches(':popover-open')) positionNotifications();});

  function distinct(key, display = value => value) {
    return [...new Set(audits.map(item => item[key]).filter(Boolean))].sort()
      .map(value => [value, display(value)]);
  }
  function renderAuditList() {
    if (!session) return;
    options($('auditFilterTeam'), distinct('equipo'), 'Todos');
    const namesByLead = new Map(audits.map(audit => [audit.tlUid,audit.nombreTL]));
    const namesByPerson = new Map(audits.map(audit => [audit.idMeli,audit.nombreColaborador]));
    options($('auditFilterLead'), distinct('tlUid', uid => nameOf(roster.get(uid),namesByLead.get(uid) || uid)), 'Todos');
    options($('auditFilterPerson'), distinct('idMeli', id => namesByPerson.get(id) ? namesByPerson.get(id) + ' · ' + id : id), 'Todos');
    options($('auditFilterPeriod'), distinct('periodo').reverse(), 'Todos');
    options($('auditFilterFlow'), distinct('flujo'), 'Todos');
    const criteria = [...filter.querySelectorAll('select')].filter(node => !node.closest('[hidden]') && node.value);
    const visible = audits.filter(audit => criteria.every(node => audit[node.name] === node.value)).sort((a,b) =>
      (b.fecha || b.periodo).localeCompare(a.fecha || a.periodo) || a.externo.localeCompare(b.externo));
    const list = $('auditRows');
    list.replaceChildren();
    $('auditListStatus').textContent = listError ? 'No se pudo consultar esta sección. Verificá que Auditorías esté habilitada.' :
      auditLoading ? 'Cargando auditorías…' : visible.length === 1 ? '1 auditoría' :
        visible.length ? format(visible.length) + ' auditorías' : 'No hay auditorías para estos filtros.';
    for (const audit of visible) {
      const row = element('tr'), cell = element('td');
      const label = audit.cdm ? [audit.cdm,audit.item].filter(Boolean).join(' · ') : audit.externo;
      cell.append(button(label, () => openDetail(audit.id), 'audit-link'));
      row.append(cell, element('td', audit.idMeli), element('td', audit.fecha || audit.periodo),
        element('td', audit.flujo || '—'), element('td', states[audit.estado] || audit.estado));
      list.append(row);
    }
  }
  filter.addEventListener('change', renderAuditList);

  function renderReports(documents) {
    reports.replaceChildren(element('h3','Importaciones recientes'));
    if (!documents.length) reports.append(element('p','Todavía no hay importaciones.'));
    for (const doc of documents) {
      const item = doc.data(), summary = item.resumen;
      const row = element('details');
      row.append(element('summary', item.archivo + ' · ' + dateText(item.fecha) + ' · ' + item.estado));
      if (summary) row.append(element('p', format(summary.publicadas) + ' publicadas · ' + format(summary.pendientes) +
        ' sin asignar · ' + format(summary.duplicadas) + ' duplicadas · ' + format(summary.rechazadas) + ' rechazadas'));
      const issues = [...(item.incidenciasArchivo || []), ...(item.duplicadosArchivo || [])];
      if (issues.length) {
        const list = element('ul');
        for (const issue of issues) list.append(element('li', issue.hoja + ' · fila ' + issue.fila + ' · ' + issue.motivo));
        row.append(list);
      }
      reports.append(row);
    }
  }

  function openDetail(id) {
    stopDetail();
    detail.hidden = false;
    $('auditDetailTitle').focus();
    detail.scrollIntoView({block:'start'});
    detailBody.append(element('p','Cargando auditoría…'));
    const ref = api.doc(api.db,'auditorias',id);
    const unavailable = () => {detailBody.replaceChildren(element('p','La auditoría ya no está disponible para tu cuenta.'));};
    detailListener = watch(ref, snapshot => {
      if (!snapshot.exists()) {unavailable();return;}
      const previous = selectedAudit;
      selectedAudit = {...snapshot.data(), id};
      if (previous?.estado !== selectedAudit.estado) renderDetail(selectedAudit);
      if (!historyListener) historyListener = watch(api.query(api.collection(ref,'historial'),api.orderBy('fecha')),
        snap => {history = snap.docs.map(item => item.data()); renderHistory();},
        () => {$('auditHistory')?.replaceChildren(element('li','No se pudo leer el historial.'));});
    }, unavailable);
  }
  $('auditCloseDetail').onclick = () => {stopDetail();$('auditTitle').focus();};
  function renderHistory() {
    const list = $('auditHistory');
    if (!list) return;
    list.replaceChildren(...history.map(item => element('li', dateText(item.fecha) + ' · ' + item.tipo +
      (item.accion ? ' (' + item.accion + ')' : '') + ' · ' + nameOf(roster.get(item.uid),item.uid))));
  }

  function renderDetail(audit) {
    const fields = element('dl', undefined, 'audit-fields');
    lines(fields, [
      ['Auditoría',audit.cdm || audit.externo], ['Colaborador',[audit.nombreColaborador,audit.idMeli].filter(Boolean).join(' · ')], ['Equipo',audit.equipo],
      ['TL',nameOf(roster.get(audit.tlUid),audit.nombreTL || audit.tlUid)], ['Estado',states[audit.estado]], ['Fecha',audit.fecha],
      ['Período',audit.periodo], ['Flujo',audit.flujo], ['Tipo',audit.tipo], ['Auditor',audit.auditor],
      ['Resultado original',audit.resultado], ['Observaciones',audit.observaciones],
      ...[['Product ID',audit.producto],['Item ID',audit.item],['Variation ID',audit.variante],
        ['Referencia de origen',audit.referencia],['Comentario de origen',audit.comentarioOrigen],
        ['Decisión de origen',audit.decisionOrigen],['Estado de origen',audit.estadoOrigen],
        ['Motivo de origen',audit.motivoOrigen],['Incidencia',audit.incidencia]].filter(([,value]) => value && value !== 'null')
    ]);
    detailBody.replaceChildren(fields);
    for (const [label, entry] of [['Respuesta del colaborador',audit.respuesta],['Decisión del TL',audit.decision]]) {
      if (entry) detailBody.append(element('h4',label), element('p',actions[entry.accion] + ' · ' +
        dateText(entry.fecha)), element('p',entry.texto || 'Sin comentario.', 'audit-message'));
    }
    const canRespond = session.role === 'catalogador' && audit.colaboradorUid === session.uid && audit.estado === 'pendiente_colaborador';
    const canDecide = session.role === 'tl' && audit.tlUid === session.uid && audit.equipo === session.team && audit.estado === 'pendiente_tl';
    if (canRespond || canDecide) renderActions(audit, canRespond);
    if (session.global && audit.estado === 'sin_asignar') renderAssignment(audit);
    const list = element('ol',undefined,'audit-history');list.id = 'auditHistory';
    detailBody.append(element('h4','Historial'), list);
    renderHistory();
  }
  async function perform(container, operation) {
    if (saving) return;
    const current = ctx(), buttons = [...container.querySelectorAll('button')], feedback = container.querySelector('[role=status]');
    saving = true; buttons.forEach(node => {node.disabled = true;});
    feedback.textContent = 'Guardando…';
    try {await operation(); if (ctx() === current) feedback.textContent = 'Guardado.';}
    catch (error) {if (ctx() === current) feedback.textContent = errorText(error);}
    finally {if (ctx() === current) {saving = false;buttons.forEach(node => {node.disabled = false;});}}
  }
  function renderActions(audit, responding) {
    const form = element('div',undefined,'audit-action');
    const textarea = element('textarea');textarea.id = 'auditResponse';textarea.maxLength = 3000;textarea.rows = 3;
    const label = element('label', responding ? 'Tu respuesta' : 'Comentario de la decisión (opcional)');
    label.htmlFor = textarea.id;
    const feedback = element('p');feedback.setAttribute('role','status');
    const buttons = element('div',undefined,'audit-actions');
    for (const action of responding ? ['responder','devolver'] : ['aprobar','rechazar']) {
      buttons.append(button(actions[action], () => {
        if (responding && !textarea.value.trim()) {feedback.textContent = 'Escribí una respuesta antes de enviarla.'; textarea.focus();return;}
        if (!responding && !window.confirm(actions[action] + ' definitivamente esta auditoría?')) return;
        void perform(form, () => api.call('auditoriasActuar',{id:audit.id, accion:action, texto:textarea.value.trim()}));
      }));
    }
    form.append(label,textarea,buttons,feedback);detailBody.append(form);
  }
  function renderAssignment(audit) {
    const form = element('div',undefined,'audit-action'), person = element('select'), lead = element('select');
    person.id = 'auditAssignPerson';lead.id = 'auditAssignLead';
    const personLabel = element('label','Cuenta de colaborador verificada');personLabel.htmlFor = person.id;
    const leadLabel = element('label','TL del mismo equipo');leadLabel.htmlFor = lead.id;
    const entries = [...roster];
    options(person, entries.filter(([,p]) => p.rol === 'catalogador' && p.equipo && p.idMeli)
      .map(([uid,p]) => [uid,nameOf(p,p.idMeli) + ' · ' + p.idMeli + ' · ' + p.equipo]), 'Seleccioná una cuenta');
    const update = () => options(lead, entries.filter(([,p]) => p.rol === 'tl' && p.equipo && p.equipo === roster.get(person.value)?.equipo)
      .map(([uid,p]) => [uid,nameOf(p,uid)]),'Seleccioná el TL');
    person.onchange = update;update();
    const feedback = element('p');feedback.setAttribute('role','status');
    form.append(personLabel,person,leadLabel,lead,button('Asignar y publicar',() => {
      if (!person.value || !lead.value) {feedback.textContent = 'Seleccioná ambas cuentas.';return;}
      if (!window.confirm('¿Confirmás que esta auditoría corresponde a la cuenta seleccionada?')) return;
      void perform(form, () => api.call('auditoriasAsignar',{id:audit.id,colaboradorUid:person.value,tlUid:lead.value}));
    }),feedback);
    detailBody.append(form);
  }

  function invalidate() {preview.hidden = true;preview.open = false;}
  function mappingFor(sheet) {
    sheet.mapping = mapHeaders(sheet.matrix[sheet.headerRow] || []);
    sheet.composite = sheet.mapping.externo < 0 && hasNetkelColumns(sheet.mapping);
  }
  function renderSheet() {
    const sheet = sheets[Number(sheetSelect.value)];
    if (!sheet) return;
    headerInput.value = sheet.headerRow + 1;
    headerInput.max = sheet.matrix.length;
    $('auditIncludeSheet').checked = sheet.include;
    $('auditComposite').checked = sheet.composite;
    const headers = sheet.matrix[sheet.headerRow] || [];
    mappingArea.replaceChildren();
    for (const [key, title] of Object.entries(labels)) {
      const label = element('label',title), select = element('select');
      options(select, headers.map((name,i) => [String(i), String(name || 'Columna ' + (i + 1)) + ' · ' + (i + 1)]),'Sin asignar');
      select.value = sheet.mapping[key] < 0 ? '' : String(sheet.mapping[key]);
      select.onchange = () => {sheet.mapping[key] = select.value === '' ? -1 : Number(select.value); invalidate();};
      label.append(select);mappingArea.append(label);
    }
    const table = $('auditSheetPreview'), head = element('thead'), header = element('tr'), body = element('tbody');
    for (const value of headers) {const th = element('th',String(value));th.scope = 'col';header.append(th);}
    head.append(header);
    for (const row of sheet.matrix.slice(sheet.headerRow + 1,sheet.headerRow + 6)) {
      const tr = element('tr');for (let i = 0; i < headers.length; i++) tr.append(element('td',String(row[i] ?? '')));body.append(tr);
    }
    table.replaceChildren(head,body);
    $('auditSheetInfo').textContent = format(Math.max(0,sheet.matrix.length-sheet.headerRow-1)) + ' filas después del encabezado';
  }
  fileInput.onchange = async () => {
    const file = fileInput.files[0], current = ++fileVersion;
    invalidate();fileSetup.hidden = true;fileSetup.open = false;sheets = [];
    importBusy(false);status.textContent = '';
    if (!file || !session?.global) return;
    loadButton.disabled = true;
    status.textContent = 'Leyendo el archivo…';
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name) || file.size > 15_000_000) throw Error('Elegí un archivo .xlsx, .xls o .csv de hasta 15 MB.');
      await api.loadXlsx();
      const bytes = await file.arrayBuffer();
      const workbook = window.XLSX.read(bytes,{type:'array',raw:true,cellDates:true,codepage:65001});
      if (current !== fileVersion) return;
      sheets = workbook.SheetNames.map(name => {
        const matrix = window.XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,raw:true,defval:'',blankrows:true});
        const first = matrix.findIndex(row => row.some(cell => String(cell).trim()));
        const sheet = {name,matrix,headerRow:Math.max(0,first),include:first >= 0};
        mappingFor(sheet);return sheet;
      });
      if (!sheets.length) throw Error('No se encontraron hojas.');
      sheetSelect.replaceChildren(...sheets.map((sheet,index) => new Option(sheet.name,String(index))));
      fileSetup.hidden = false;renderSheet();
      loadButton.disabled = false;
      status.textContent = '';
    } catch (error) {if (current === fileVersion) status.textContent = error.message;}
  };
  sheetSelect.onchange = renderSheet;
  headerInput.onchange = () => {
    const sheet = sheets[Number(sheetSelect.value)], index = Number(headerInput.value) - 1;
    if (Number.isInteger(index) && index >= 0 && index < sheet.matrix.length) {sheet.headerRow = index;mappingFor(sheet);}
    invalidate();renderSheet();
  };
  $('auditIncludeSheet').onchange = event => {sheets[Number(sheetSelect.value)].include = event.target.checked;invalidate();};
  $('auditComposite').onchange = event => {sheets[Number(sheetSelect.value)].composite = event.target.checked;invalidate();};
  $('auditReferenceMonth').onchange = invalidate;
  function importBusy(value) {
    busy = value;
    upload.querySelectorAll('input, select, button').forEach(node => {node.disabled = value;});
    loadButton.disabled = value || !sheets.length;
  }
  function renderPreview(result) {
    preview.hidden = false;
    const groups = [['Válidas y asignadas',result.validas],['Sin asignar',result.incidencias],
      ['Duplicadas',result.duplicadas],['Rechazadas',result.rechazadas]];
    const results = $('auditPreviewResults');
    results.replaceChildren();
    for (const [label, entries] of groups) {
      const details = element('details');
      details.append(element('summary',label + ' · ' + format(entries.length)));
      const list = element('ul');
      for (const row of entries) list.append(element('li',[row.hoja,'Fila ' + row.fila,row.identificador,row.periodo,row.motivo].filter(Boolean).join(' · ')));
      details.append(list);results.append(details);
    }
  }
  loadButton.onclick = async () => {
    if (!session?.global || busy || !sheets.length) return;
    const current = ctx();
    invalidate();importBusy(true);status.textContent = 'Validando columnas y cuentas de colaboradores…';
    try {
      let filas;
      try {
        filas = sheets.filter(sheet => sheet.include).flatMap(sheet => mapAuditRows(sheet,$('auditReferenceMonth').value,window.XLSX.SSF.parse_date_code));
        if (!filas.length) throw Error('Incluí una hoja con filas de auditorías.');
      } catch (error) {
        fileSetup.open = true;
        status.textContent = error.message;
        return;
      }
      const request = {archivo:fileInput.files[0].name,filas};
      const validation = await api.call('auditoriasImportar',{...request,confirmar:false});
      if (ctx() !== current) return;
      renderPreview(validation);
      if (!validation.validas.length && !validation.incidencias.length && !validation.duplicadas.length) {
        status.textContent = 'No se guardó ninguna auditoría. Revisá las filas rechazadas.';
        return;
      }
      status.textContent = 'Guardando auditorías…';
      const result = await api.call('auditoriasImportar',{...request,confirmar:true});
      if (ctx() !== current) return;
      status.textContent = (result.repetida ? 'Importación ya completada. ' : 'Importación completada. ') +
        format(result.publicadas) + ' publicadas · ' + format(result.pendientes) + ' sin asignar · ' +
        format(result.duplicadas) + ' duplicadas · ' + format(result.rechazadas) + ' rechazadas.';
    } catch (error) {if (ctx() === current) status.textContent = errorText(error) + ' Podés reintentar la misma importación.';}
    finally {if (ctx() === current) importBusy(false);}
  };
  return {start,stop,closeView,openView};
}
