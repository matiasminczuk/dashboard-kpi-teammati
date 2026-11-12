import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analysisPeriod,inPeriod,periodBucket,normalizeQualityFlow,operationalFlow,achievement,creationSeries,holdsErrorRanking,itemUrl,productivityTotals,publishedProductivity} from './gestion-desarrollo.mjs';

test('rol de la base, mínimos sin tope y Know Values sin cumplimiento',()=>{
 assert.equal(operationalFlow('Analista KV'),'kv');
 assert.equal(operationalFlow('Analista Soporte'),'soporte');
 assert.equal(operationalFlow('Analista Validaciones'),'mixto');
 assert.deepEqual(achievement(118,100),{difference:18,percent:118});
 assert.deepEqual(achievement(14,11),{difference:3,percent:14/11*100});
 assert.deepEqual(achievement(70,null),{difference:null,percent:null});
 assert.equal(productivityTotals([]).average,null);
});
test('recupera las jornadas de publicaciones anteriores con el criterio histórico de Flujo Mixto',()=>{
 const publication={idMeli:123,equipo:'Equipo A',tareas:[
  {fecha:'2026-11-02',tipo:'tareas',cantidad:110},
  {fecha:'2026-11-03',tipo:'tareas',cantidad:19},
  {fecha:'2026-11-04',tipo:'tareas',cantidad:12,rolOrigen:'Analista Soporte'},
  {fecha:'2026-11-05',tipo:'tareas',cantidad:10,flujoOperativo:'kv'}
 ],gestion:[
  {fecha:'2026-11-02',flujos:{SOPORTE:0,CCC:8}},
  {fecha:'2026-11-03',flujos:{KNOWN_VALUE:3,CCC:5}},
  {fecha:'2026-11-04',flujos:{SOPORTE:8}}
 ]};
 const rows=publishedProductivity(publication,initiative=>initiative);
 assert.deepEqual(rows.filter(row=>row.tipo==='tareas').map(row=>row.flujoOperativo),['mixto',null,'soporte','kv']);
 assert.equal(rows[0].id,'123');
 assert.deepEqual(productivityTotals(rows.filter(row=>row.flujoOperativo==='mixto')),{days:1,people:1,average:110});
});
test('cuenta las correcciones de Finalizadas por jornada sin duplicar registros importados',()=>{
 const publication={idMeli:'123',nombre:'Catalogador',equipo:'Equipo A',tareas:[
  {tipo:'correcciones',fecha:'2026-10-05',cantidad:10},
  {tipo:'correcciones',fecha:'2026-10-07',cantidad:3}
 ],gestion:[
  {fecha:'2026-10-05',flujos:{'Sugerencia de Corrección':2,'CORRECCIONES masivas':4,Creaciones:20}},
  {fecha:'2026-10-06',flujos:{Creaciones:4}}
 ]};
 const rows=publishedProductivity(publication,()=>null);
 assert.deepEqual(rows.map(({fecha,cantidad})=>[fecha,cantidad]).sort(),[
  ['2026-10-05',6],['2026-10-06',0],['2026-10-07',3]
 ]);
 assert.equal(creationSeries(rows,'weeks')[0].correcciones,9);
});
test('período inclusivo, comparación anterior de igual duración y agrupaciones',()=>{
 const periods=analysisPeriod({from:'2026-11-03',to:'2026-11-08'},{});
 assert.deepEqual(periods.previous,{start:'2026-10-28',end:'2026-11-02'});
 assert.equal(inPeriod('2026-11-08',periods.current),true);
 assert.equal(inPeriod('2026-11-09',periods.current),false);
 assert.equal(periodBucket('2026-11-08','weeks'),'2026-11-02');
 assert.equal(periodBucket('2026-11-08','months'),'2026-11');
 assert.equal(analysisPeriod({from:'2026-02-30',to:'2026-03-01'},{}),null);
});
test('CCC histórico, enlaces seguros y series independientes sin valores inventados',()=>{
 assert.equal(normalizeQualityFlow('Auditoría MAO'),'CCC');
 assert.equal(itemUrl('MLA-123456'),'https://meli-one-source.adminml.com/item-view?item_id=MLA123456');
 assert.equal(itemUrl('MLA123456&otro=1'),null);
 const rows=[{fecha:'2026-11-03',tipo:'creaciones',cantidad:5},{fecha:'2026-11-04',tipo:'correcciones',cantidad:2}];
 assert.deepEqual(creationSeries(rows,'days'),[
  {key:'2026-11-03',creaciones:5,correcciones:null},{key:'2026-11-04',creaciones:null,correcciones:2}]);
 assert.deepEqual(creationSeries(rows,'months'),[{key:'2026-11',creaciones:5,correcciones:2}]);
});
test('ranking agrega variantes sin dividir acciones múltiples ni contabilizar null',()=>{
 const rows=['Revisar atributos',' revisar  atributos ','Revisar atributos / Validar','null'].map(accionCorrecta=>({accionCorrecta,fecha:'2026-11-03',cantidad:1}));
 const result=holdsErrorRanking(rows,'weeks');
 assert.equal(result.length,2);assert.equal(result[0].rank,1);assert.equal(result[0].count,2);
 assert.equal(result[1].count,1);assert.deepEqual(result[0].trend,[['2026-11-02',2]]);
});
