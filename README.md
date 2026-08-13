# 📷 Escáner de QR (webcam)

Sistema independiente (fuera de `sage-gestion`) que usa la webcam de la PC para
leer códigos QR en tiempo real, **enviar el token a la API de sage**
(`POST /guest/scan`) y **mostrar la respuesta** (entrada/salida, motivo y estado
al que migra el QR).

## Requisitos

- [Node.js](https://nodejs.org) v20.6 o superior (usa `process.loadEnvFile`).
- Una webcam conectada a la PC.
- Un navegador moderno: **Chrome, Edge o Firefox**.
- La API de `sage-gestion` corriendo (por defecto en `http://localhost:3000`).

> Sin dependencias npm: la librería de QR (`jsqr.js`) está incluida localmente
> y el servidor usa solo módulos nativos de Node.

## Configuración (secreto compartido)

La API de sage exige autenticación (Auth0). Para que el escáner pueda llamar a
`POST /guest/scan` sin JWT, ambos sistemas comparten un **secreto**:

1. En la API de sage, agregá al `.env`:
   ```
   SCANNER_SHARED_SECRET=un-secreto-largo-y-secreto
   ```
   (ya está soportado: permite `POST /guest/scan` con el header
   `X-Scanner-Secret`).

2. En esta carpeta (qr-scanner), copiá el ejemplo y completá el **mismo** valor:
   ```bash
   cp .env.example .env
   ```
   ```
   SAGE_API_URL=http://localhost:3000
   SCANNER_SHARED_SECRET=un-secreto-largo-y-secreto
   ```

El secreto viaja **solo entre los dos servidores**: el navegador llama a
`/api/scan` (este servidor) y el `server.js` reenvía a sage agregando el header
`X-Scanner-Secret`. El navegador nunca ve el secreto.

## Cómo ejecutar

```bash
cd qr-scanner
npm start          # o: node server.js
```

Se abre solo el navegador en `http://localhost:8080` y el escaneo arranca solo.

## Qué hace

- Muestra el **video en vivo** con recuadro de escaneo.
- Decodifica QR continuamente (color + escala de grises, ambas inversiones).
- Extrae el token (si es una URL `.../guest/qr/<token>`, toma el último tramo).
- Envía `{ qrToken }` a `/guest/scan` vía el proxy interno `/api/scan`.
- Muestra la **respuesta de sage**: ENTRADA/SALIDA, invitado, evento, motivo de
  rechazo y el **estado resultante** del QR (No llegó / Dentro / Fuera).
- Panel de **diagnóstico** (vista previa del frame, FPS, resolución) y botón
  **"Probar con imagen"** para aislar problemas de cámara vs. decoder.
- Botones: **Copiar token**, **Limpiar lista**, **Iniciar/Detener**.

## Notas

- La webcam requiere **contexto seguro**; por eso se sirve vía `http://localhost`.
- Para probar ENTRADA → SALIDA con el mismo QR: sacá el QR del encuadre y volvé
  a mostrarlo (así se habilita una nueva lectura).
- Si en "Conexión con sage" aparece ⚠️, falta el secreto en el `.env` del
  escáner. Si al escanear ves "No autorizado (401)", el secreto no coincide con
  el de la API.

