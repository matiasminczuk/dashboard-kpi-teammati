const assert = require('node:assert/strict');
const {after, test} = require('node:test');
const {createRequire} = require('node:module');
const {setTimeout: pause} = require('node:timers/promises');
const web = createRequire(require('node:path').resolve(__dirname,'../desktop/package.json'));
const live = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const projectId = 'demo-dashboard-kpi';
const apps = [];
let admin;

test('auditorías, permisos, eventos y lecturas con Firebase local', {skip:!live,timeout:120000}, async () => {
  const adminApp = require('firebase-admin/app');
  const adminFirestore = require('firebase-admin/firestore');
  const app = web('firebase/app');
  const auth = web('firebase/auth');
  const store = web('firebase/firestore');
  const funcs = web('firebase/functions');
  admin = adminApp.initializeApp({projectId});
  const backend = adminFirestore.getFirestore(admin);
  async function account(name, profile) {
    const instance = app.initializeApp({projectId, apiKey:'demo-key', appId:'demo-app'},name);
    apps.push(instance);
    const login = auth.getAuth(instance);
    auth.connectAuthEmulator(login,'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST,{disableWarnings:true});
    const {user} = await auth.createUserWithEmailAndPassword(login,name+'@example.test','password123');
    const db = store.getFirestore(instance);
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    store.connectFirestoreEmulator(db,host,Number(port));
    const functions = funcs.getFunctions(instance,'us-central1');
    funcs.connectFunctionsEmulator(functions,'127.0.0.1',5001);
    await backend.collection('usuarios').doc(user.uid).set(profile);
    return {uid:user.uid,db,call:async (name,data)=>(await funcs.httpsCallable(functions,name)(data)).data,
      async reconnect() {await auth.signOut(login);await auth.signInWithEmailAndPassword(login,name+'@example.test','password123');}};
  }
  const pm = await account('pm',{rol:'pm'});
  const tl = await account('tl',{rol:'tl',equipo:'A'});
  const foreignTl = await account('foreign-tl',{rol:'tl',equipo:'B'});
  const collaborator = await account('collaborator',{rol:'catalogador',equipo:'A',idMeli:'001',usuario:'NET_COLAB'});
  const stranger = await account('stranger',{rol:'catalogador',equipo:'B',idMeli:'002'});
  const row = (externo, fila, idMeli='NET_COLAB') => ({
    externo, fila, idMeli, hoja:'Datos', fecha:'2026-10-02', resultado:'Original'
  });
  const filas = [row('a',2),row('b',3),row('b',4),row('c',5,'desconocido'),{...row('inválida',6),fecha:'2026-02-30'}];
  const request = {archivo:'auditorias.csv',filas};
  const result = await pm.call('auditoriasImportar',{...request,confirmar:false});
  assert.deepEqual([result.validas.length,result.incidencias.length,result.duplicadas.length,result.rechazadas.length],[2,1,1,1]);
  await assert.rejects(tl.call('auditoriasImportar',{...request,confirmar:true}),/no puede/);
  const saved = await pm.call('auditoriasImportar',{...request,confirmar:true});
  assert.deepEqual([saved.guardadas,saved.publicadas,saved.pendientes],[3,2,1]);
  assert.equal((await pm.call('auditoriasImportar',{...request,confirmar:true})).repetida,true);

  const audits = store.collection(collaborator.db,'auditorias');
  const own = await store.getDocs(store.query(audits,store.where('colaboradorUid','==',collaborator.uid)));
  assert.equal(own.size,2);
  const teamAudits = store.collection(tl.db,'auditorias');
  assert.equal((await store.getDocs(store.query(teamAudits,store.where('equipo','==','A')))).size,2);
  await assert.rejects(store.getDocs(audits),{code:'permission-denied'});
  const [first, second] = own.docs;
  await assert.rejects(store.getDoc(store.doc(stranger.db,'auditorias',first.id)),{code:'permission-denied'});
  await assert.rejects(store.updateDoc(first.ref,{resultado:'Falso'}),{code:'permission-denied'});

  const inbox = account => store.collection(account.db,'usuarios',account.uid,'notificaciones');
  async function notices(account,type,quantity) {
    for (let i=0;i<80;i++) {
      const query = store.query(inbox(account),store.where('tipo','==',type));
      const docs = (await store.getDocsFromServer(query)).docs;
      if (docs.length >= quantity) return docs;
      await pause(250);
    }
    assert.fail('No llegó el aviso ' + type);
  }

  const [assigned] = await notices(collaborator,'auditoria_nueva',1);
  assert.equal((await store.getDocs(inbox(collaborator))).size,1);
  await assert.rejects(store.getDoc(store.doc(stranger.db,assigned.ref.path)),{code:'permission-denied'});
  await assert.rejects(store.setDoc(store.doc(inbox(collaborator),'falso'),{tipo:'meta'}),{code:'permission-denied'});
  await assert.rejects(store.updateDoc(assigned.ref,{mensaje:'Falso'}),{code:'permission-denied'});
  await store.updateDoc(assigned.ref,{leidaEn:store.serverTimestamp()});
  await collaborator.reconnect();
  assert.ok((await store.getDocFromServer(assigned.ref)).data().leidaEn);
  assert.equal((await store.getDocs(store.query(inbox(collaborator),store.where('leidaEn','==',null)))).size,0);

  await assert.rejects(stranger.call('auditoriasActuar',{id:first.id,accion:'responder',texto:'Ajeno'}),/no puede/);
  let unwatch;
  const realTime = new Promise((resolve,reject) => {
    unwatch = store.onSnapshot(store.query(inbox(tl),store.where('tipo','==','auditoria_respuesta')),snapshot => {
      if (snapshot.size) resolve(snapshot.docs[0].data());
    },reject);
  });
  const attempts = await Promise.allSettled([1,2].map(()=>collaborator.call('auditoriasActuar',{id:first.id,accion:'responder',texto:'Mi respuesta'})));
  assert.equal(attempts.filter(attempt=>attempt.status==='fulfilled').length,1);
  assert.equal((await realTime).auditoriaId,first.id);
  unwatch();
  await assert.rejects(foreignTl.call('auditoriasActuar',{id:first.id,accion:'aprobar',texto:''}),/no puede/);
  assert.equal((await tl.call('auditoriasActuar',{id:first.id,accion:'aprobar',texto:''})).estado,'cerrada_aprobada');
  await collaborator.call('auditoriasActuar',{id:second.id,accion:'devolver',texto:'Mi devolución'});
  assert.equal((await tl.call('auditoriasActuar',{id:second.id,accion:'rechazar',texto:'Decisión'})).estado,'cerrada_rechazada');
  await assert.rejects(tl.call('auditoriasActuar',{id:first.id,accion:'rechazar',texto:''}),/no puede/);
  await notices(collaborator,'auditoria_cierre',2);
  assert.equal((await store.getDocFromServer(first.ref)).data().resultado,'Original');
  const history = await store.getDocs(store.collection(first.ref,'historial'));
  assert.equal(history.size,5);
  await assert.rejects(store.deleteDoc(history.docs[0].ref),{code:'permission-denied'});

  const pending = (await store.getDocs(store.query(store.collection(pm.db,'auditorias'),store.where('estado','==','sin_asignar')))).docs[0];
  await assert.rejects(pm.call('auditoriasAsignar',{id:pending.id,colaboradorUid:collaborator.uid,tlUid:foreignTl.uid}),/TL/);
  await pm.call('auditoriasAsignar',{id:pending.id,colaboradorUid:collaborator.uid,tlUid:tl.uid});
  await notices(collaborator,'auditoria_nueva',2);

  const sourceHold = store.doc(pm.db,'kpis','001','registros','hold_1');
  await store.setDoc(sourceHold,{tipo:'hold',operacionAviso:'witness'});
  const loadRecord = {tipo:'holds',estado:'completado',notificar:true,usuario:pm.uid,afectados:['001'],
    testigos:{'001':'hold_1'},operacionAviso:'witness'};
  await store.setDoc(store.doc(pm.db,'importaciones','holds-carga'),loadRecord);
  await notices(tl,'holds',1);
  assert.equal((await store.getDocs(store.query(inbox(collaborator),store.where('tipo','==','holds')))).size,0);

  const kpi = store.doc(pm.db,'kpi_publicados','001');
  await store.setDoc(kpi,{idMeli:'001',equipo:'A',notificacionVersion:'v1',holds:[{cantidad:2}],gestion:[{total:1}]});
  const publishRecord = {
    tipo:'kpi_publicacion',estado:'completado',notificar:true,usuario:pm.uid,afectados:['001'],versiones:{'001':'v1'}
  };
  await store.setDoc(store.doc(pm.db,'importaciones','publicacion-prueba'),publishRecord);
  await notices(collaborator,'kpi_publicacion',1);
  assert.equal((await notices(collaborator,'holds_publicados',1))[0].data().destino,'holds');
  assert.equal((await notices(collaborator,'finalizadas_publicadas',1))[0].data().destino,'finalizadas');
  await notices(tl,'kpi_publicacion',1);
  assert.equal((await store.getDocs(inbox(foreignTl))).size,0);
  await store.setDoc(store.doc(pm.db,'importaciones','publicacion-fallida'),{
    ...publishRecord,estado:'fallido'
  });
  await store.setDoc(store.doc(pm.db,'importaciones','publicacion-repetida'),publishRecord);
  await store.updateDoc(kpi,{notificacionVersion:'v2',holds:[{cantidad:3}]});
  await store.setDoc(store.doc(pm.db,'importaciones','publicacion-holds'),{...publishRecord,versiones:{'001':'v2'}});
  await notices(collaborator,'holds_publicados',2);
  assert.equal((await store.getDocs(store.query(inbox(collaborator),store.where('tipo','==','kpi_publicacion')))).size,1);
  assert.equal((await store.getDocs(store.query(inbox(collaborator),store.where('tipo','==','finalizadas_publicadas')))).size,1);

  for (const [type,recordType] of [['productividad','tareas'],['gestion','gestion']]) {
    await store.setDoc(store.doc(pm.db,'kpis','001','registros',type),{tipo:recordType,operacionAviso:type});
    await store.setDoc(store.doc(pm.db,'importaciones',type),{...loadRecord,tipo:type,testigos:{'001':type},operacionAviso:type});
    await notices(tl,type,1);
    assert.equal((await store.getDocs(store.query(inbox(collaborator),store.where('tipo','==',type)))).size,0);
  }

  await store.setDoc(store.doc(pm.db,'bases_calidad','base-prueba'),{estado:'completado',notificar:true,usuario:pm.uid});
  await notices(pm,'calidad_carga',1);
  assert.equal((await store.getDocs(store.query(inbox(collaborator),store.where('tipo','==','calidad')))).size,0);
  await store.setDoc(store.doc(pm.db,'calidad_publicada','001'),{equipo:'A',registros:{a:{base:'base-prueba'}}});
  await store.setDoc(store.doc(pm.db,'importaciones','calidad-prueba'),{
    tipo:'calidad',estado:'completado',notificar:true,usuario:pm.uid,afectados:['001'],hash:'base-prueba'
  });
  await notices(collaborator,'calidad',1);
  await notices(tl,'calidad',1);
  await store.setDoc(store.doc(pm.db,'calidad_config','objetivo'),{valor:95});
  await notices(collaborator,'meta',1);
  await notices(foreignTl,'meta',1);
});

after(async () => {
  if (apps.length) await Promise.all(apps.map(web('firebase/app').deleteApp));
  if (admin) await require('firebase-admin/app').deleteApp(admin);
});
