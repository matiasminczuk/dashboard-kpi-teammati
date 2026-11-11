import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mapHeaders, mapAuditRows, hasNetkelColumns, auditDate} from './auditorias-import.mjs';
import domain from './functions/audit-domain.cjs';

const {access, assignment, normalizeRow, transition} = domain;
const profiles = new Map([
  ['pm',{rol:'pm'}], ['tl',{rol:'tl',equipo:'A'}], ['leadB',{rol:'tl',equipo:'B'}],
  ['employee',{rol:'catalogador',idMeli:'0001',username:'NET_COLAB',equipo:'A'}],
  ['other',{rol:'catalogador',idMeli:'0002',equipo:'B'}]
]);

test('mapea columnas Netkel, conserva identificadores y usa una clave que distingue items del mismo CDM', () => {
  const headers=['Fecha auditoría','Flujo','Colaborador','ID CDM','Product ID','Item ID','Variation ID','Acción correcta','Comentario auditor'];
  const mapping=mapHeaders(headers);
  assert.equal(hasNetkelColumns(mapping), true);
  const matrix=[headers,['2 oct 2026','CCC','NET_COLAB','012','P1','I1','V1','Original','Obs'],
    ['2 oct 2026','CCC','NET_COLAB','012','P1','I2','V1','Original','Obs']];
  const rows=mapAuditRows({matrix,mapping,name:'Datos',headerRow:0,composite:true},'',()=>null).map(normalizeRow);
  assert.equal(rows[0].fecha,'2026-10-02');
  assert.equal(rows[0].periodo,'2026-10');
  assert.equal(rows[0].cdm,'012');
  assert.notEqual(rows[0].externo,rows[1].externo);
  assert.equal(rows[0].resultado,'Original');
});

test('pide mapeo para campos ambiguos y rechaza fechas o períodos inválidos', () => {
  const headers=['ID auditoría','Colaborador','Usuario','Resultado'];
  const mapping=mapHeaders(headers);
  assert.equal(mapping.idMeli,-1);
  assert.throws(()=>mapAuditRows({matrix:[headers],mapping,name:'Datos',headerRow:0,composite:false},'2026-10',()=>null), /mapeo/);
  assert.throws(()=>normalizeRow({externo:'A',idMeli:'0001',fecha:'2026-02-29',resultado:'Original',fila:2}), /Fecha inválida/);
  assert.throws(()=>normalizeRow({externo:'A',idMeli:'0001',fecha:'2026-10-02',periodo:'2026-11',resultado:'Original',fila:2}), /no coinciden/);
  assert.equal(auditDate('02/10/2026',()=>null),'2026-10-02');
  assert.equal(auditDate(2,()=>({y:1900,m:1,d:2})),'1900-01-02');
});

test('resuelve identificadores exactos y exige un TL de ese equipo', () => {
  assert.equal(assignment('net_colab',profiles).colaboradorUid,'employee');
  assert.equal(assignment('0001',profiles).tlUid,'tl');
  assert.match(assignment('net',profiles).incidencia,/sin cuenta/);
  assert.match(assignment('0001',profiles,'employee','leadB').incidencia,/TL/);
  const ambiguous = new Map([...profiles,['second',{rol:'tl',equipo:'A'}]]);
  assert.match(assignment('0001',ambiguous).incidencia,/varios TL/);
  assert.equal(assignment('0001',ambiguous,'employee','second').tlUid,'second');
});

test('respeta permisos otorgados y la revocación de un Superadmin emisor', () => {
  const owner='zzCZDpLLzvaGpxe3zuqAp2sVtB42';
  const grants=new Map([
    ['tl',{activo:true,nivel:'superadmin',otorgadoPor:owner}],
    ['leadB',{activo:true,nivel:'delegado',otorgadoPor:'tl'}]
  ]);
  assert.equal(access('pm',profiles,grants).global,true);
  assert.equal(access('leadB',profiles,grants).global,true);
  grants.get('tl').activo=false;
  assert.equal(access('leadB',profiles,grants).global,false);
  assert.equal(access('employee',profiles,grants).global,false);
});

test('solo el colaborador y el TL asignados avanzan el circuito y el cierre es definitivo', () => {
  const audit={colaboradorUid:'employee',tlUid:'tl',equipo:'A',estado:'pendiente_colaborador',resultado:'Original'};
  assert.equal(transition(audit,'other',profiles.get('other'),'responder'),null);
  assert.equal(transition(audit,'employee',profiles.get('employee'),'devolver'),'pendiente_tl');
  audit.estado='pendiente_tl';
  assert.equal(transition(audit,'leadB',profiles.get('leadB'),'aprobar'),null);
  assert.equal(transition(audit,'tl',profiles.get('tl'),'aprobar'),'cerrada_aprobada');
  assert.equal(transition(audit,'tl',profiles.get('tl'),'rechazar'),'cerrada_rechazada');
  for (const state of ['cerrada_aprobada','cerrada_rechazada']) {
    audit.estado=state;
    assert.equal(transition(audit,'tl',profiles.get('tl'),'rechazar'),null);
    assert.equal(transition(audit,'employee',profiles.get('employee'),'responder'),null);
  }
  assert.equal(audit.resultado,'Original');
});
