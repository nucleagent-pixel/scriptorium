# Scriptorium

App interna de operaciones del equipo NUCLEA: Inicio, Productos (con el semáforo de ROAS), Líneas, Tareas, Calendario con actas y Agentes.
Corre en **Cloudflare Workers** (página + API) con **Supabase** como base de datos y login, igual que el NUCLEA Dashboard.

## Qué incluye esta versión (fase 1)

- **Login por persona** con correo y contraseña. La primera persona que entra queda como **admin**; las demás quedan **pendientes** hasta que un admin las aprueba desde su avatar (arriba a la derecha) → *Tu cuenta*.
- **Datos compartidos en vivo**: lo que una persona cambia lo ven las demás sin recargar.
- **Semáforo de ROAS automático**: cada producto se conecta a una oferta del NUCLEA Dashboard y muestra el ROAS por país de los últimos 3 días (hoy y los 2 anteriores, hora de Colombia). ROAS = facturación neta ÷ pauta. Verde 1.80 o más, ámbar 1.43 a 1.79, rojo 1.42 o menos; bajo 1.25 aparece *apagar*. Se refresca cada 10 minutos. Un producto sin oferta conectada puede llevar el ROAS a mano.
- **Agentes** con Claude: texto, PDF, documentos de texto e imágenes. Las entregas se guardan en el producto.

Siguientes fases: agentes con sus skills y adjuntos de audio y video; sincronización con Google Calendar.

## Instalación

### 1. Supabase

Scriptorium puede usar **el mismo proyecto de Supabase del Dashboard** (un solo login, el ROAS se lee directo) o **uno nuevo**. Todas sus tablas empiezan por `sc_`, así que no chocan con las del Dashboard, y su acceso es aparte: aprobar a alguien en Scriptorium no le da acceso a la caja del Dashboard.

1. En Supabase → **SQL Editor → New query**, pega `supabase/migrations/0001_scriptorium.sql` y dale **Run**.
2. En **Authentication → URL Configuration → Redirect URLs**, agrega la URL de Scriptorium (la del paso 2), por ejemplo `https://scriptorium.TU-USUARIO.workers.dev/**`. Así los correos de confirmación y de recuperar contraseña vuelven a Scriptorium.

### 2. Cloudflare (publicación automática desde GitHub)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Import a repository** → elige `scriptorium`.
2. Comando de build vacío; comando de despliegue `npx wrangler deploy`.
3. En el Worker → **Settings → Variables and Secrets**, agrega como **Secret**:

   | Nombre | Valor |
   |---|---|
   | `SUPABASE_URL` | URL del proyecto, solo `https://xxxx.supabase.co` |
   | `SUPABASE_ANON_KEY` | llave anon |
   | `SUPABASE_SERVICE_ROLE_KEY` | llave service_role (secreta) |
   | `ANTHROPIC_API_KEY` | clave de la API de Anthropic para los agentes |
   | `DASH_SUPABASE_URL` | **solo si** el Dashboard está en otro proyecto: su URL |
   | `DASH_SUPABASE_KEY` | **solo si** el Dashboard está en otro proyecto: su llave service_role |

4. Desde ahora, cada cambio que se suba a `main` se publica solo.

### 3. Primer ingreso

1. Abre la URL del Worker → **Crear cuenta**. Serás el admin.
2. El equipo crea su cuenta; tú los apruebas en tu avatar → *Tu cuenta* → *Acceso* = Equipo.
3. En **Productos**, edita cada producto y elige su **Oferta en el NUCLEA Dashboard**.

## Desarrollo

```bash
npm install
cp .dev.vars.example .dev.vars   # y llena los valores
npm run dev
npm test && npm run typecheck
```

`public/index.html` se genera desde el prototipo aprobado con `scripts/port.py`; los cambios nuevos se hacen directo en `public/index.html`.
