

## Cambios preparados en `fix/revision-hallazgos`

- Sal e IV aleatorios por sesión en el handshake P2P; el IV se transporta junto con el primer ciphertext de autenticación.
- Redacción del SAS token en los logs del agente y del cliente.
- Presentación textual segura en la consola del agente y en el explorador de archivos.
- Borrado del blob de entrada sólo después de validar y completar la tarea.
- Corrección de `pop()` por `splice()`, de `this_agent` y del listener IPC acumulativo.
- Manejo iterativo de errores de `TaskLoop()` y validación del payload de tareas.

La rama **no sustituye todavía AES-CBC por AEAD**, no convierte todo el frontend a `contextBridge`/preload y no elimina todos los usos de `innerHTML` que sólo renderizan plantillas estáticas o valores previamente escapados. Esas son tareas separadas que requieren revisar compatibilidad de protocolo y UI.
