# Auditorías y notificaciones en Firebase Spark

En **Configuración → Cargar bases → Auditorías**, seleccioná el Excel o CSV y pulsá **Cargar**. Se detectan las columnas y se valida el archivo. Si falta una columna obligatoria o un período, se abre **Ajustar columnas y hojas**. El detalle muestra filas asignadas, sin asignar, duplicadas y rechazadas.

El formato Netkel usa una clave con fecha, flujo, identificador del colaborador, CDM, producto, ítem y variación. «Acción correcta» queda como resultado original. Los comentarios, estado y decisión de origen se conservan como referencia. Para otros formatos podés mapear un ID de auditoría estable entre archivos.

La asignación automática requiere un identificador exacto y un TL único del equipo. Si hay ambigüedad, la auditoría queda pendiente de asignación. Los gestores autorizados pueden elegir explícitamente al colaborador y al TL de su equipo. El colaborador puede responder o devolver su auditoría. El TL asignado la aprueba o rechaza, con cierre definitivo y resultado original preservado.

## Datos y reglas

- `auditorias/{id}` conserva el origen, el ámbito, el estado y los campos inmutables de la carga, asignación, respuesta y decisión. El historial se reconstruye a partir de esos campos.
- `importaciones_auditorias/{id}` conserva el resumen de la importación. Las claves de auditoría se calculan en el navegador. Los lotes se pueden reintentar y una auditoría registrada conserva su documento original.
- Los avisos de auditoría se derivan de los documentos que cada perfil ya puede leer. Se agrupan las auditorías nuevas de un archivo por colaborador. Los avisos de KPI, Calidad y objetivos para TL y colaboradores reflejan las últimas fichas o metas publicadas. Los gestores con acceso global también ven las cargas administrativas recientes. El estado de lectura se guarda en `usuarios/{uid}/lecturas_avisos/{id}`.
- `firestore.spark.rules` permite crear auditorías a los gestores autorizados, vincula cada destinatario con su perfil y aplica el circuito de estados en Firestore. El colaborador y el TL solo pueden escribir su acción. El cliente no puede alterar el origen, reabrir una auditoría, crear avisos en los buzones ni tocar lecturas ajenas.
- Esta versión usa Auth y Firestore dentro de las cuotas de Spark. Las transacciones y listeners consumen lecturas y escrituras de esas cuotas.

## Pruebas y publicación

Con Node.js 22, Java 21 y Firebase CLI, desde la raíz:

```powershell
npm --prefix functions ci
npm --prefix desktop ci
node --test auditorias.test.mjs calidad.test.mjs desktop/desktop.test.cjs
node desktop/build-renderer.mjs
firebase --config firebase.spark.json --project demo-dashboard-kpi emulators:exec --only auth,firestore "node --test functions/spark.integration.test.cjs"
```

La prueba usa Firebase Admin únicamente para preparar perfiles ficticios en el emulador. Para publicar, comparar las reglas activas con la base del proyecto, desplegar solo Firestore Rules con `firebase.spark.json` y publicar el frontend. La versión de Windows necesita un instalador que incluya el mismo frontend.
