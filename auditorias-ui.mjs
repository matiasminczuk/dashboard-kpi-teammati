import {itemUrl,normalizeQualityFlow} from './gestion-desarrollo.mjs';
import {labels, mapHeaders, mapAuditRows, hasNetkelColumns} from './auditorias-import.mjs?v=checks-tl';
import {auditReviewTotals, auditScope, observeSparkNotices, ownsAudit, watchAuditScope, auditResponseOpen, auditResponseDeadline} from './auditorias-spark.mjs?v=plazo';

const states = {
  sin_asignar:'Sin asignar', sin_error:'Sin error', pendiente_colaborador:'Pendiente del colaborador',
  vencida:'Vencida · sin respuesta', pendiente_tl:'Pendiente del TL', pendiente_pm:'Pendiente del PM', cerrada_aprobada:'Cerrada · aprobada',
  cerrada_rechazada:'Cerrada · rechazada'
};
const actions = {responder:'Confirmar error', devolver:'Devolver al TL', aprobar:'Aprobar y cerrar', rechazar:'Rechazar y cerrar'};
const confirmedFinding = 'Hallazgo confirmado por el colaborador.';
const recordedActions = {responder:'Respondió', devolver:'Devolvió al TL', aprobar:'Aprobó', rechazar:'Rechazó'};
const eventLabels = {productividad:'Productividad', holds:'Holds', gestion:'Finalizadas', calidad:'Calidad',
  calidad_carga:'Calidad', kpi_publicacion:'Productividad', holds_publicados:'Holds',
  finalizadas_publicadas:'Finalizadas', meta:'Objetivos'};
const dateFormat = new Intl.DateTimeFormat('es-AR', {dateStyle:'medium', timeStyle:'short'});
const dateText = value => value?.toDate ? dateFormat.format(value.toDate()) : '—';
const nameOf = (profile, fallback) => profile?.nombre || profile?.nombreCompleto || profile?.usuario || fallback;
const auditDisplayState = audit => audit.estado === 'pendiente_colaborador' && !auditResponseOpen(audit) ? 'vencida' : audit.estado;

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
    const detail = element('dd');
    detail.append(value && value !== 'null' ? value : '—');
    row.append(element('dt', label), detail);
    return row;
  }));
}
function auditCard(title, className) {
  const card = element('section', undefined, 'audit-card');
  const fields = element('dl', undefined, 'audit-fields ' + className);
  card.append(element('h4', title, 'audit-card-heading'), fields);
  return {card, fields};
}
function auditTag(label, tone = 'neutral') {
  const tag = element('span', label, 'audit-tag');
  tag.dataset.tone = tone;
  return tag;
}
function auditDecision(title, decision, comment, tone) {
  const section = element('section', undefined, 'audit-decision');
  const note = String(comment ?? '').trim();
  section.append(element('h4', title), auditTag(decision, tone),
    element('p', note && note.toLowerCase() !== 'null' ? note : 'Sin comentario.', 'audit-message'));
  return section;
}
function auditedCaseLink(audit) {
  const url = itemUrl(audit.item);
  if (!url) return element('span', 'El caso requiere un Item ID válido.', 'audit-case-unavailable');
  const link = element('a', 'Abrir caso auditado', 'audit-case-button');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS(svg.namespaceURI,'path');
  path.setAttribute('d','M13 5h6v6m0-6-9 9m0-9H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4');
  svg.append(path);
  link.append(svg);
  return link;
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
  let session, listeners = [], audits = [], all = [], unread = [], detailListener, historyListener, deadlineTimer;
  let inbox, inboxListener, visibleNotices = 100;
  let sparkItems = [], sparkRead = new Map();
  let selectedAudit, history = [], roster = new Map(), sheets = [], fileVersion = 0, busy = false;
  let notificationError = false, onlyUnread = false, listError = false, auditLoading = false, saving = false;
  const format = number => new Intl.NumberFormat('es-AR').format(number);
  const ctx = () => session;
  let detailVersion = 0;

  function stopDetail() {
    detailVersion++;
    clearTimeout(deadlineTimer);
    detailListener?.(); historyListener?.(); detailListener = historyListener = undefined;
    selectedAudit = undefined; history = [];
    if (detail.open) detail.close();
    detailBody.replaceChildren();
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
    $('auditMetrics').replaceChildren();
    $('auditMetrics').hidden = true;
    reports.replaceChildren();
    roster = new Map(); audits = []; all = []; unread = []; sheets = [];
    notificationError = false; onlyUnread = false; listError = false; auditLoading = false;
    sparkItems = []; sparkRead = new Map();
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
    filter.querySelectorAll('[data-audit-staff]').forEach(node => {node.hidden = profile.role === 'catalogador';});
    filter.reset();
    const stateFilter = filter.elements.estado;
    const collaborator = profile.role === 'catalogador';
    for (const option of stateFilter.options) {
      if (['','sin_asignar','sin_error'].includes(option.value)) option.disabled = option.hidden = collaborator;
    }
    if (collaborator) stateFilter.value = 'pendiente_colaborador';
    inbox = api.collection(api.db, 'usuarios', profile.uid, 'notificaciones');
    watchInbox();
    listeners.push(watch(api.query(inbox, api.where('leidaEn','==',null)), snap => {
      unread = snap.docs; renderNotifications();
    }, () => {notificationError = true; renderNotifications();}));
    listeners.push(watch(api.collection(api.db,'usuarios',profile.uid,'lecturas_avisos'),snap => {
      sparkRead = new Map(snap.docs.map(record => [record.id,record.data().leidaEn]));
      renderNotifications();
    }, () => {notificationError = true; renderNotifications();}));
    listeners.push(...observeSparkNotices(api,profile,watch,items => {
      sparkItems = items;
      renderNotifications();
    }));
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
    auditLoading = auditScope(api,session,session.global).length > 0;
    listeners.push(...watchAuditScope(api,session,watch,snap => {
      audits = snap.docs.map(doc => ({...doc.data(), id:doc.id, flujo:normalizeQualityFlow(doc.data().flujo)||doc.data().flujo}));
      auditLoading = false; listError = false; renderAuditList();
      api.onAuditsChange?.();
    }, () => {auditLoading = false; listError = true; renderAuditList(); api.onAuditsChange?.();},session.global));
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

  function sparkDocuments() {
    if (!session) return [];
    return sparkItems.map(item => ({
      spark:true,ref:api.doc(api.db,'usuarios',session.uid,'lecturas_avisos',item.id),
      data:()=>({...item,leidaEn:sparkRead.get(item.id) || null})
    }));
  }
  function unreadDocuments(spark = sparkDocuments()) {
    return [...unread,...spark.filter(record => !record.data().leidaEn)];
  }
  function renderNotifications() {
    const spark = sparkDocuments(), pending = unreadDocuments(spark), count = pending.length;
    unreadCount.hidden = count === 0;
    unreadCount.textContent = count > 99 ? '99+' : String(count);
    bell.setAttribute('aria-label', count ? 'Notificaciones · ' + count + ' sin leer' : 'Notificaciones');
    $('notificationCount').textContent = format(count) + ' sin leer';
    $('notificationReadAll').disabled = !count;
    $('notificationsAll').setAttribute('aria-pressed', String(!onlyUnread));
    $('notificationsUnread').setAttribute('aria-pressed', String(onlyUnread));
    const sorted = (onlyUnread ? pending : [...all,...spark]).sort((a,b) =>
      (b.data().creadoEn?.toMillis?.() || 0) - (a.data().creadoEn?.toMillis?.() || 0));
    const entries = onlyUnread ? sorted : sorted.slice(0,visibleNotices);
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
    if (!onlyUnread && sorted.length > visibleNotices) list.append(button('Ver anteriores', event => {
      event.currentTarget.disabled = true;
      visibleNotices += 100;
      watchInbox();
    },'notification-item'));
  }
  async function markRead(entries) {
    for (let i = 0; i < entries.length; i += 350) {
      const batch = api.writeBatch(api.db);
      for (const doc of entries.slice(i, i + 350)) {
        const read = {leidaEn:api.serverTimestamp()};
        if (doc.spark) batch.set(doc.ref,read);
        else batch.update(doc.ref,read);
      }
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
    try {await markRead(unreadDocuments());}
    catch {if (ctx() === current) $('notificationStatus').textContent = 'No se pudieron marcar todas como leídas.';}
    finally {if (ctx() === current) $('notificationReadAll').disabled = !unreadDocuments().length;}
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
    const scoped = api.auditFilter ? audits.filter(api.auditFilter) : audits;
    const criteria = [...filter.querySelectorAll('select')].filter(node => !node.closest('[hidden]') && node.value);
    const matches = (audit,node) => node.name === 'resultadoError'
      ? (audit.estado === 'sin_error' ? 'sin' : 'con') === node.value
      : (node.name === 'estado' ? auditDisplayState(audit) : audit[node.name]) === node.value;
    const metrics = $('auditMetrics');
    metrics.hidden = session.role === 'catalogador' || auditLoading || listError;
    if (!metrics.hidden) {
      const selected = criteria.filter(node => node.name !== 'estado');
      const totals = auditReviewTotals(scoped.filter(audit =>
        (session.role !== 'tl' || audit.equipo === session.team) && selected.every(node => matches(audit,node))));
      lines(metrics,[
        ['Colaboradores al día',format(totals.revisaron)],['Colaboradores con revisiones pendientes',format(totals.sinRevisar)],
        ['Aprobadas por TL',format(totals.aprobadasTl)],['Rechazadas por TL',format(totals.rechazadasTl)],
        ['Pendientes del PM',format(totals.pendientesPm)],['Cierre aprobado por PM',format(totals.aprobadasPm)],
        ['Cierre rechazado por PM',format(totals.rechazadasPm)]
      ]);
    }
    const visible = scoped.filter(audit => criteria.every(node => matches(audit,node))).sort((a,b) =>
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
        element('td', audit.flujo || '—'), element('td', states[auditDisplayState(audit)] || audit.estado));
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
        ' sin asignar · ' + format(summary.sinError || 0) + ' sin error · ' +
        format(summary.duplicadas) + ' duplicadas · ' + format(summary.rechazadas) + ' rechazadas'));
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
    detailBody.append(element('p','Cargando auditoría…'));
    detail.showModal();
    detail.scrollTop = 0;
    $('auditDetailTitle').focus({preventScroll:true});
    const ref = api.doc(api.db,'auditorias',id);
    const unavailable = () => {detailBody.replaceChildren(element('p','La auditoría ya no está disponible para tu cuenta.'));};
    detailListener = watch(ref, snapshot => {
      if (!snapshot.exists()) {unavailable();return;}
      const previous = selectedAudit;
      selectedAudit = {...snapshot.data(), id};
      if (previous?.estado !== selectedAudit.estado) renderDetail(selectedAudit);
      else renderHistory();
      if (!historyListener) historyListener = watch(api.query(api.collection(ref,'historial'),api.orderBy('fecha')),
        snap => {history = snap.docs.map(item => item.data()); renderHistory();},
        () => {$('auditHistory')?.replaceChildren(element('li','No se pudo leer el historial.'));});
    }, unavailable);
  }
  $('auditCloseDetail').onclick = stopDetail;
  detail.addEventListener('cancel', event => {
    event.preventDefault();
    stopDetail();
  });
  function renderHistory() {
    const list = $('auditHistory');
    if (!list) return;
    const audit = selectedAudit;
    const events = history.length || !audit ? history : [
      {tipo:'importada',uid:audit.cargadaPor,fecha:audit.creadaEn},
      ...(audit.publicadaEn ? ['asignada','publicada'].map(tipo => ({tipo,uid:audit.asignadaPor || audit.cargadaPor,fecha:audit.publicadaEn})) : []),
      ...(audit.respuesta ? [{...audit.respuesta,tipo:'respuesta'}] : []),
      ...(audit.decision ? [{...audit.decision,tipo:'decisión del TL'}] : []),
      ...(audit.decisionPm ? [{...audit.decisionPm,tipo:'decisión final del PM'}] : [])
    ].filter(item => item.fecha);
    list.replaceChildren(...events.map(item => element('li', dateText(item.fecha) + ' · ' + item.tipo +
      (item.accion ? ' (' + item.accion + ')' : '') + ' · ' + nameOf(roster.get(item.uid),item.uid))));
  }

  function renderDetail(audit) {
    clearTimeout(deadlineTimer);
    const collaboratorView = session.role === 'catalogador';
    detail.classList.toggle('audit-collaborator-view', collaboratorView);
    const overview = element('div', undefined, 'audit-detail-overview');
    const originDecision = String(audit.decisionOrigen ?? '').trim();
    const decisionKey = originDecision.toLowerCase();
    const hasDecision = decisionKey !== '' && decisionKey !== 'null';
    const originLabel = hasDecision ? originDecision : 'Pendiente de decisión';
    const originTone = decisionKey === 'desestimar' ? 'warning' : hasDecision ? 'info' : 'neutral';
    if (collaboratorView) {
      const result = String(audit.resultado ?? '').trim();
      overview.append(
        auditDecision('Decisión del colaborador', originLabel, audit.comentarioOrigen, originTone),
        auditDecision('Decisión del auditor', result && result.toLowerCase() !== 'null' ? result : 'Sin resultado registrado',
          audit.observaciones, 'info')
      );
    } else {
      const collaborator = auditCard('Datos del colaborador', 'audit-identity');
      lines(collaborator.fields, [
        ['Auditoría', audit.cdm || audit.externo],
        ['ID MELI', audit.colaboradorIdMeli || audit.idMeli],
        ['Equipo', audit.equipo],
        ['Auditor', audit.auditor]
      ]);
      const decision = auditCard('Decisión del colaborador', 'audit-origin');
      lines(decision.fields, [
        ['Decisión del colaborador', auditTag(originLabel, originTone)],
        ['Comentario del colaborador', audit.comentarioOrigen]
      ]);
      overview.append(collaborator.card, decision.card);
    }

    const auditCase = auditCard('Detalle del caso', 'audit-case-fields');
    const flow = normalizeQualityFlow(audit.flujo) || audit.flujo;
    const stateTone = {cerrada_aprobada:'positive', cerrada_rechazada:'negative'}[audit.estado] || 'neutral';
    lines(auditCase.fields, [
      ...(collaboratorView ? [['Auditoría', audit.cdm || audit.externo]] :
        [['Resultado original', audit.resultado], ['Comentario del auditor', audit.observaciones]]),
      ['Product ID', audit.producto],
      ['Item ID', audit.item],
      ['Flujo', flow && flow !== 'null' ? auditTag(flow) : null],
      ['Estado', states[auditDisplayState(audit)] ? auditTag(states[auditDisplayState(audit)], stateTone) : null],
      ['Fecha', audit.fecha || audit.periodo]
    ]);
    detailBody.replaceChildren(overview);
    const caseLink = auditedCaseLink(audit);
    if (collaboratorView) {
      detailBody.append(caseLink);
    } else {
      const footer = element('div', undefined, 'audit-actions audit-detail-actions audit-case-footer');
      footer.append(caseLink);
      auditCase.card.append(footer);
      detailBody.append(auditCase.card);
    }
    let deadlineNote;
    if (audit.estado === 'pendiente_colaborador') {
      const deadline = auditResponseDeadline(audit);
      const label = auditResponseOpen(audit) ? 'Plazo de respuesta hasta el ' : 'Plazo de respuesta vencido el ';
      const deadlineFormat = new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Argentina/Buenos_Aires'});
      deadlineNote = element('p',deadline === null?'Sin fecha de publicación para calcular el plazo.':
        label+deadlineFormat.format(deadline)+' (Argentina).','audit-message audit-deadline');
      if (!collaboratorView) detailBody.append(deadlineNote);
      if(deadline !== null && deadline > Date.now()){
        deadlineTimer=setTimeout(()=>{
          renderAuditList();
          renderDetail(audit);
        },Math.min(deadline-Date.now()+1,2147483647));
      }
    }
    for (const [label, entry] of [['Respuesta del colaborador',audit.respuesta],['Decisión del TL',audit.decision],['Decisión final del PM',audit.decisionPm]]) {
      if (!entry) continue;
      const confirmed = entry.accion === 'responder' && entry.texto === confirmedFinding;
      detailBody.append(element('h4',label), element('p',(entry.accion === 'responder' ? 'Confirmó el hallazgo' : recordedActions[entry.accion]) + ' · ' +
        dateText(entry.fecha)));
      if (!confirmed) detailBody.append(element('p',entry.texto || 'Sin comentario.', 'audit-message'));
    }
    const canRespond = session.role === 'catalogador' && ownsAudit(audit,session.uid,session.idMeli) && audit.estado === 'pendiente_colaborador' && auditResponseOpen(audit);
    const canDecide = session.role === 'tl' && audit.tlUid === session.uid && audit.equipo === session.team && audit.estado === 'pendiente_tl';
    const canClose = ['pm','admin'].includes(session.role) && audit.estado === 'pendiente_pm';
    if (canRespond || canDecide || canClose) renderActions(audit, canRespond, canClose);
    if (collaboratorView) {
      if (deadlineNote) detailBody.append(deadlineNote);
      const caseDetails = element('details', undefined, 'audit-timeline audit-case-details');
      caseDetails.append(element('summary', 'Datos del caso'), auditCase.fields);
      detailBody.append(caseDetails);
    }
    if (session.global && audit.estado === 'sin_asignar') renderAssignment(audit);
    const list = element('ol',undefined,'audit-history');list.id = 'auditHistory';
    const timeline = element('details',undefined,'audit-timeline');
    timeline.append(element('summary','Historial'), list);
    detailBody.append(timeline);
    renderHistory();
  }
  async function perform(container, operation, closeAfterSave = false) {
    if (saving) return;
    const current = ctx(), buttons = [...container.querySelectorAll('button')], feedback = container.querySelector('[role=status]');
    const version = detailVersion;
    saving = true; buttons.forEach(node => {node.disabled = true;});
    feedback.textContent = 'Guardando…';
    try {
      await operation();
      if (ctx() === current && version === detailVersion) {
        if (closeAfterSave) stopDetail();
        else feedback.textContent = 'Guardado.';
      }
    }
    catch (error) {if (ctx() === current) feedback.textContent = errorText(error);}
    finally {if (ctx() === current) {saving = false;buttons.forEach(node => {node.disabled = false;});}}
  }
  function renderActions(audit, responding, closing) {
    const form = element('div',undefined,'audit-action');
    const textarea = element('textarea');textarea.id = 'auditResponse';textarea.maxLength = 3000;textarea.rows = 2;
    const card = element('section', undefined, 'audit-card audit-response-card');
    card.append(element('h4', responding ? 'Tu respuesta' : 'Revisión de la auditoría', 'audit-card-heading'));
    if (responding) textarea.placeholder = 'Obligatorio para devolver al TL. Opcional para confirmar el error.';
    const label = element('label', responding ? 'Comentario' : 'Comentario de la decisión (opcional)');
    label.htmlFor = textarea.id;
    const feedback = element('p');feedback.setAttribute('role','status');
    const buttons = element('div',undefined,'audit-actions audit-detail-actions');
    for (const action of responding ? ['responder','devolver'] : ['aprobar','rechazar']) {
      const label = responding || closing ? actions[action] :
        action === 'aprobar' ? 'Aprobar y enviar al PM' : 'Rechazar y enviar al PM';
      buttons.append(button(label, () => {
        const texto = textarea.value.trim() || (action === 'responder' ? confirmedFinding : '');
        if (action === 'devolver' && !texto) {feedback.textContent = 'Escribí el motivo de la devolución al TL.'; textarea.focus();return;}
        if (action === 'responder' && !window.confirm('¿Confirmás que estás de acuerdo con el hallazgo de la auditoría?')) return;
        if (!responding && !window.confirm(closing ? '¿Confirmás el cierre definitivo de esta auditoría?' :
          '¿Confirmás tu decisión y el envío al PM?')) return;
        void perform(form, () => api.call('auditoriasActuar',{id:audit.id, accion:action, texto}), true);
      }, action === 'devolver' ? 'audit-return-button' : undefined));
    }
    form.append(label,textarea,buttons,feedback);
    card.append(form);
    detailBody.append(card);
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
    const groups = [['Con error y asignadas',result.validas],['Sin error',result.sinError || []],['Sin asignar',result.incidencias],
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
    let savingImport = false;
    invalidate();importBusy(true);status.textContent = 'Validando columnas y cuentas de colaboradores…';
    try {
      let filas;
      try {
        filas = sheets.filter(sheet => sheet.include).flatMap(sheet => mapAuditRows(sheet,$('auditReferenceMonth').value,window.XLSX.SSF.parse_date_code));
        if (!filas.length) throw Error('Incluí una hoja con filas de auditorías.');
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      const request = {archivo:fileInput.files[0].name,filas};
      const validation = await api.call('auditoriasImportar',{...request,confirmar:false});
      if (ctx() !== current) return;
      renderPreview(validation);
      if (!validation.validas.length && !validation.sinError.length && !validation.incidencias.length && !validation.duplicadas.length) {
        status.textContent = 'No se guardó ninguna auditoría. Revisá las filas rechazadas.';
        return;
      }
      status.textContent = 'Guardando auditorías…';
      savingImport = true;
      const result = await api.call('auditoriasImportar',{...request,confirmar:true,onProgress(done,total){
        if (ctx() === current) status.textContent = 'Procesando auditorías… ' + format(done) + ' de ' + format(total) + '.';
      }});
      if (ctx() !== current) return;
      status.textContent = (result.repetida ? 'Importación ya completada. ' : 'Importación completada. ') +
        format(result.publicadas) + ' publicadas para revisión · ' + format(result.pendientes) + ' sin asignar · ' +
        format(result.sinError || 0) + ' sin error · ' +
        format(result.duplicadas) + ' duplicadas · ' + format(result.rechazadas) + ' rechazadas.';
    } catch (error) {
      if (ctx() !== current) return;
      const code = error.code?.split('/').at(-1);
      if (['not-found','unavailable','internal','deadline-exceeded'].includes(code)) {
        status.textContent = savingImport
          ? 'Firebase no confirmó el guardado. Podés reintentar el mismo archivo sin duplicar auditorías.'
          : 'El servicio de importación no está disponible en Firebase. La carga no llegó al guardado. Consultá al administrador.';
      } else {
        status.textContent = error.code ? errorText(error) : error.message;
      }
    }
    finally {if (ctx() === current) importBusy(false);}
  };
  return {start,stop,closeView,openView,refresh:renderAuditList,
    qualityAudits(){
      if (!session || !auditScope(api,session,session.global).length) return null;
      listenAudits();
      return auditLoading || listError ? null : audits;
    }
  };
}
