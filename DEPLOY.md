# Cómo desplegar en Render

Render **no acepta subir un .zip directamente**: despliega leyendo un
repositorio de Git (GitHub, GitLab o Bitbucket). Así que el primer paso
siempre es subir esta carpeta a un repositorio.

## Paso 1 — Subir el proyecto a GitHub

Si no tenés el proyecto en GitHub todavía:

1. Entrá a [github.com/new](https://github.com/new) y creá un repositorio
   (puede ser privado). No hace falta que lo inicialices con nada.
2. En la carpeta del proyecto (donde está `package.json`), corré:
   ```bash
   git init
   git add .
   git commit -m "Version inicial"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
   git push -u origin main
   ```

   > El proyecto ya trae un `.gitignore` implícito para lo importante,
   > pero verificá que no subas `.env` (con contraseñas reales) ni la
   > carpeta `node_modules`. Si no existe, creá un archivo `.gitignore`
   > con estas líneas:
   > ```
   > node_modules/
   > .env
   > uploads/
   > storage/
   > ```

## Paso 2 — Crear cuenta en Render y conectar el repo

1. Entrá a [render.com](https://render.com) y creá una cuenta (podés
   entrar directo con tu cuenta de GitHub, es lo más simple).
2. Una vez adentro, andá a **New +** → **Blueprint**.
3. Elegí el repositorio que acabás de subir. Render va a detectar
   automáticamente el archivo `render.yaml` que ya está en el proyecto
   y te va a proponer crear **dos cosas juntas**:
   - Un **Web Service** (`fundacion-soy-sistema`) — el servidor Node.
   - Una base de datos **PostgreSQL** (`fundacion-soy-db`).
4. Confirmá ("Apply"). Render va a:
   - Crear la base de datos.
   - Conectar automáticamente su `DATABASE_URL` al servicio web (ya está
     configurado en `render.yaml`, no hay que copiarla a mano).
   - Correr `npm install && npm run migrate` (instala dependencias y
     aplica el esquema de la base) y después `npm start`.

Esto tarda unos minutos la primera vez. Cuando termine, Render te da una
URL pública tipo `https://fundacion-soy-sistema.onrender.com`.

## Paso 3 — Completar la configuración desde la app

Una vez que la app esté arriba:

1. Entrá a la URL que te dio Render.
2. Andá a **Configuración ARCA** y completá lo que ya tengas (CUIT, punto
   de venta). Mientras no tengas el certificado real, dejá el ambiente en
   **"Simulado (mock)"** — así podés probar todo el flujo ya mismo.
3. Probá importar un archivo de donaciones y facturar el lote.

## Paso 4 (opcional) — Variables adicionales

Si más adelante conseguís el certificado de ARCA, en Render andá a tu
Web Service → **Environment** y agregá:

- `ARCA_CERT_PATH` / `ARCA_KEY_PATH`: rutas al certificado (en Render
  esto normalmente se resuelve subiendo el archivo como un **Secret
  File** desde la pestaña "Environment" → "Secret Files", y apuntando la
  variable a esa ruta).
- `ARCA_CUIT_EMISOR`, `ARCA_PUNTO_VENTA`: podés cargarlos ahí en vez de
  desde la pantalla de Configuración si preferís manejarlo como secreto.

## Aviso importante: comprobantes y adjuntos

El plan gratuito/starter de Render **no tiene disco persistente por
defecto**: los archivos que se suban a `/uploads` (comprobantes de
egresos) se van a perder cada vez que el servicio se reinicie o haga un
nuevo deploy. Para que los comprobantes queden guardados de forma
permanente, hay dos caminos:

1. **Más simple:** agregar un "Disk" persistente al Web Service desde el
   dashboard de Render (Render → tu servicio → "Disks" → "Add Disk",
   montado por ejemplo en `/opt/render/project/src/uploads`). Tiene un
   costo mensual bajo, pero es la opción que menos cambia el código.
2. **Más robusta a largo plazo:** subir los comprobantes a un storage
   externo (Cloudflare R2, AWS S3) en vez de al disco local — requiere
   un cambio en `src/routes/egresos.js`. Si preferís este camino, te lo
   armo cuando estés por pasar a producción.

Mientras estés probando el sistema (Fase 1, modo mock), esto no es
urgente — solo hay que resolverlo antes de depender de los comprobantes
para la contabilidad real.
