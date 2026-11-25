import test from 'node:test';
import assert from 'node:assert/strict';
import {mapHeaders,mapAuditRows} from './auditorias-import.mjs';

const headers=['Fecha auditoría','Suggestion ID','Decisión colab','Código rechazo','Atributo/Sección','Link','Colaborador','Auditor TL','Dominio','ESTADO_SUGERENCIA_V2','Detalle','Check TL','Check motivo TL','Acción correcta','Comentario','Casuistica'];
const base=['15 oct 2026','MLMS123','REJECTED','U-ODG','WIDTH','https://catalog-domains.adminml.com/catalogo/bc-admin/sugerencias/revision/MLMS123','ext_persona','ext_tl','DOMINIO','REJECTED','null','OK','NOT OK','U-GEN','Comentario','null'];
const parse=rows=>mapAuditRows({matrix:[headers,...rows],mapping:mapHeaders(headers),name:'Sheet1',headerRow:0,composite:false},'',()=>null);

test('SCP reconoce columnas, mantiene atributos separados y clasifica por ambos checks',()=>{
  const approved=[...base];approved[4]='HEIGHT';approved[11]='OK';approved[12]='OK';approved[13]='null';
  const rows=parse([base,approved]);
  assert.equal(rows[0].flujo,'SCP');assert.equal(rows[0].decisionOrigen,'REJECTED');
  assert.equal(rows[0].motivoOrigen,'U-ODG');assert.equal(rows[0].resultado,'U-GEN');
  assert.equal(rows[0].observaciones,'Comentario');assert.equal(rows[0].fecha,'2026-10-15');
  assert.notEqual(rows[0].externo,rows[1].externo);assert.equal(rows[1].resultado,'null');
  assert.equal(parse([base])[0].externo,rows[0].externo);
});

test('SCP conserva los errores sin acción correcta como datos faltantes explícitos',()=>{
  const row=[...base];row[13]='null';
  assert.match(parse([row])[0].resultado,/Acción correcta no informada/);
  row[11]='NOT OK';row[12]='OK';
  assert.match(parse([row])[0].resultado,/Check TL \(NOT OK\)/);
});
