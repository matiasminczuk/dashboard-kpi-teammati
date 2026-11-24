import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pmOperationalFlow,initiativeFlow,pmTaskDistribution,pmPeopleDistribution} from './pm-analytics.mjs';

test('PM agrupa variantes históricas en tres flujos sin perder colaboradores',()=>{
  for(const value of ['KV','Known_Value','Known Values','Know Values','Analista KV','Knowns Values','Known Values (KV)']){
    assert.equal(pmOperationalFlow(value),'kv',value);
  }
  assert.equal(pmOperationalFlow('Analista Soporte'),'soporte');
  assert.equal(pmOperationalFlow(undefined),'mixto');
  assert.deepEqual(pmPeopleDistribution([
    {id:'a',fecha:'2026-11-01',tipo:'tareas'},
    {id:'a',fecha:'2026-11-03',tipo:'tareas',flujoOperativo:'kv'},
    {id:'b',fecha:'2026-11-01',tipo:'tareas',rolOrigen:'Soporte'},
    {id:'c',fecha:'2026-11-01',tipo:'tareas',rolOrigen:'Otra iniciativa'},
    {id:'c',fecha:'2026-11-01',tipo:'creaciones',flujoOperativo:'kv'}
  ]),{mixto:1,soporte:1,kv:1});
});

test('PM clasifica iniciativas en origen y conserva el volumen de finalizadas',()=>{
  assert.equal(initiativeFlow('Sugerencia de corrección'),'mixto');
  assert.equal(initiativeFlow('Demanda'),'mixto');
  assert.equal(initiativeFlow('Iniciativa histórica'),'mixto');
  assert.equal(initiativeFlow('Denuncias_BPP'),'soporte');
  assert.deepEqual(pmTaskDistribution([{flujos:{CCC:5,'Sugerencia de corrección':3,Denuncias_BPP:2,Known_Value:4}}]),
    {mixto:8,soporte:2,kv:4});
});

test('la distribución usa tareas y calcula 40 % de Mixto sobre mil tareas',()=>{
  const rows=[
    {id:'a',total:400,flujos:{CCC:250,'Sugerencia de corrección':150}},
    {id:'a',total:350,flujos:{Denuncias_BPP:350}},
    {id:'b',total:250,flujos:{KNOWN_VALUE:250}}
  ];
  const groups=pmTaskDistribution(rows);
  const total=Object.values(groups).reduce((sum,count)=>sum+count,0);
  assert.equal(total,1000);
  assert.deepEqual(groups,{mixto:400,soporte:350,kv:250});
  assert.equal(groups.mixto/total*100,40);
});
