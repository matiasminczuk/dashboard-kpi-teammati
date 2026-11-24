import test from 'node:test';
import assert from 'node:assert/strict';
import {auditErrorRanking} from './auditorias-ranking.mjs';

test('filtra el ranking por flujo, incluyendo MAO histórico y SDC sin flujo explícito',()=>{
  const rows=[
    {flujo:'MAO',decisionOrigen:'Desestimar',resultado:'Producto genérico'},
    {estadoOrigen:'REJECTED',resultado:'Aprobar',referencia:'https://catalog-domains.adminml.com/catalogo/bc-admin/sugerencias/revision/mlas123'},
    {flujo:'SDC',estadoOrigen:'APPROVED',resultado:'null'},
  ];
  assert.equal(auditErrorRanking(rows,'CCC')[0].decision,'Desestimar');
  assert.equal(auditErrorRanking(rows,'SDC')[0].decision,'REJECTED');
  assert.deepEqual(auditErrorRanking(rows,'FO'),[]);
  assert.equal(auditErrorRanking(rows).length,2);
});

test('conserva la decisión explícita y no confunde estados de seguimiento con decisiones',()=>{
  const rows=[
    {decisionOrigen:'Desestimar',estadoOrigen:'APPROVED',resultado:'Aprobar'},
    {decisionOrigen:' desestimar ',resultado:'aprobar'},
    {estadoOrigen:'Pendiente',resultado:'Otro resultado'},
    {estado:'sin_error',resultado:'Aprobar'},
  ];
  const groups=auditErrorRanking(rows);
  assert.equal(groups[0].decision,'Desestimar');
  assert.equal(groups[0].count,2);
  assert.equal(groups[1].decision,'Sin decisión registrada');
});
