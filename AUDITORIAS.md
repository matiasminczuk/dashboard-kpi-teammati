# Auditorías y notificaciones

## Importación y estados

En **Configuración → Cargar bases → Auditorías**, seleccioná un Excel o CSV y pulsá **Cargar**. El sistema detecta las columnas, valida las filas y publica las auditorías con destinatario verificado. Si falta una columna obligatoria o un período, se abre **Ajustar columnas y hojas**. El detalle muestra las filas asignadas, sin asignar, duplicadas y rechazadas. El servidor vuelve a validar al guardar.

El formato Netkel se reconoce por sus columnas. La clave usa fecha, flujo, identificador del colaborador, CDM, producto, ítem y variación. «Acción correcta» queda como resultado original. Los comentarios, el estado y la decisión de origen se guardan como referencia. Para otros formatos podés seleccionar una columna de ID de auditoría. Los IDs externos deben identificar una auditoría de forma estable entre archivos. Las claves duplicadas con datos distintos se reportan como conflicto. El mismo ID ya guardado conserva su auditoría original.

El servidor compara el identificador completo con el ID MELI, usuario o prefijo de correo registrado en un perfil de colaborador. Si faltan una cuenta verificable, su equipo o un TL único, la auditoría queda sin asignar. PM, Admin y TL con permiso global vigente pueden resolverla eligiendo explícitamente una cuenta y un TL del mismo equipo.

La publicación deja la auditoría pendiente del colaborador. Su respuesta o devolución la pasa al TL asignado. Aprobar o rechazar cierra la auditoría de forma definitiva. El resultado de origen se conserva. Cada cambio guarda actor y fecha en un historial de solo lectura para la aplicación.

## Datos y propuesta de reglas

- `auditorias/{id}` guarda los datos de origen, el ámbito, el estado y las decisiones. `historial/{eventoId}` registra las acciones. La asignación manual queda en el historial.
- `importaciones_auditorias/{id}` guarda el resultado de cada importación y hasta 200 incidencias y 200 duplicados en el resumen histórico. La vista previa muestra el detalle completo de la importación seleccionada. Se procesan hasta 5.000 filas por operación y el cliente admite archivos de hasta 15 MB.
- `usuarios/{uid}/notificaciones/{id}` guarda los avisos de ese UID. Cloud Functions crea el contenido. El destinatario puede guardar la fecha de lectura. Una importación agrupa las auditorías nuevas por destinatario y los reintentos conservan el estado de lectura.
- `firestore.propuesta.rules` contiene las reglas actuales y los bloques nuevos. Los perfiles con acceso global vigente pueden consultar auditorías e importaciones. El TL consulta el ámbito de su equipo y el colaborador consulta su UID. Las escrituras de auditorías e historial pasan por Cloud Functions. Las reglas actuales están en `firestore.rules`.
- Productividad, Holds y Finalizadas avisan a gestión al guardar cambios y al equipo cuando quedan publicados los indicadores. Calidad avisa al guardar el archivo y a los destinatarios afectados al publicar resultados. El servidor comprueba las fichas que respaldan el aviso y compara los indicadores por sección para que republicar los mismos datos conserve el buzón. La actualización de objetivos se detecta en la escritura confirmada de la configuración.
- Los estados y recibos internos de publicación se guardan en `notificaciones_kpi_estado` y `notificaciones_kpi_eventos`. El acceso directo desde la aplicación está cerrado. Si una importación de auditorías se interrumpe, el informe indica el error y el mismo archivo se puede reintentar. Las transacciones ya confirmadas conservan sus auditorías e historial.

## Comprobación local

Con Node.js 22, Java 21 y Firebase CLI disponibles, desde la raíz:

```powershell
npm --prefix functions ci
npm --prefix desktop ci
node --test auditorias.test.mjs calidad.test.mjs desktop/desktop.test.cjs
node desktop/build-renderer.mjs
firebase --config firebase.auditorias.json --project demo-dashboard-kpi emulators:exec --only auth,firestore,functions "node --test functions/integration.test.cjs"
```

La prueba de emuladores usa cuentas y documentos ficticios. Cubre el circuito, el rechazo de accesos cruzados, el agrupamiento de avisos, la persistencia de lectura y la publicación de KPI. La app de escritorio compila los mismos módulos web y admite las llamadas a Functions del proyecto configurado.

## Habilitación después de aprobar

1. Revisar el diff entre `firestore.rules` y `firestore.propuesta.rules`. Confirmar el proyecto, la base `(default)`, su ubicación y los requisitos de Cloud Functions de segunda generación.
2. Validar reglas y funciones en un proyecto de prueba, con un PM, un TL autorizado, un TL común y dos colaboradores en equipos distintos. Verificar la correspondencia de las cuentas Netkel con los perfiles reales antes de confirmar una importación.
3. Con autorización de publicación, usar `firebase.auditorias.json` para desplegar las siete funciones de este módulo por nombre y las reglas propuestas en el proyecto aprobado. Revisar primero las funciones existentes en el proyecto. Publicar el frontend web y distribuir una compilación de Windows que incluya el mismo frontend. Comprobar que llegan los avisos con una importación y una publicación controladas.
