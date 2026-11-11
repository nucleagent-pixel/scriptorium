# Scriptorium

App interna de operaciones del equipo NUCLEA: Inicio, Productos (con el semáforo de ROAS), Líneas, Tareas, Calendario con actas y Agentes.
Corre en **Cloudflare Workers** (página + API) con **Supabase** como base de datos y login, igual que el NUCLEA Dashboard.

## Qué incluye esta versión (fase 1)

- **Login por persona** con correo y contraseña. La primera persona que entra queda como **admin**; las demás quedan **pendientes** hasta que un admin las aprueba desde su avatar (arriba a la derecha) → *Tu cuenta*.
- **Datos compartidos en vivo**: lo que una persona cambia lo ven las demás sin recargar.
- **Semáforo de ROAS automático**: cada producto se conecta a una oferta del NUCLEA Dashboard y muestra el ROAS por país de los últimos 3 días (hoy y los 2 anteriores, hora de Colombia). ROAS = facturación neta ÷ pauta. Verde 1.80 o más, ámbar 1.43 a 1.79, rojo 1.42 o menos; bajo 1.25 aparece *apagar*. Se refresca cada 10 minutos. Un producto sin oferta conectada puede llevar el ROAS a mano.
- **Agentes en Claude con el conector MCP**: cada agente se usa dentro de Claude con su skill (desarrollo de producto, creadora de producto, editar reel) y la suscripción de cada persona. Con el conector, Claude lee productos, ROAS y tareas de Scriptorium y guarda las entregas de vuelta en el producto. La pantalla Agentes arma el mensaje de inicio, abre Claude y muestra las entregas guardadas.

Siguiente fase: sincronización con Google Calendar.

## Conector MCP (para Claude)

URL: `https://<tu-worker>/mcp/<MCP_KEY>`. Cualquier persona aprobada la puede copiar en Agentes → *Primera vez: conectar Scriptorium a Claude*.

| Herramienta | Qué hace |
|---|---|
| `listar_productos` | Productos con línea, avatar, etapas y ROAS por país (3 días) con semáforo |
| `ver_producto` | Ficha completa: enlaces, tareas abiertas y entregas anteriores |
| `guardar_entrega` | Guarda lo que hizo un agente en el producto (con enlace opcional a Drive) |
| `listar_entregas` | Entregas guardadas, con o sin el texto |
| `listar_tareas`, `crear_tarea`, `actualizar_tarea` | Tareas del equipo |
| `registrar_hallazgo` | Anunciante modelable para Productos → Encontrados |
| `ver_equipo` | Nombres del equipo para asignar tareas |

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
   | `MCP_KEY` | clave larga y aleatoria del conector de Claude (mínimo 24 caracteres; por ejemplo, genera una en [passwordsgenerator.net](https://passwordsgenerator.net) con 40 letras y números, sin símbolos) |
   | `DASH_SUPABASE_URL` | **solo si** el Dashboard está en otro proyecto: su URL |
   | `DASH_SUPABASE_KEY` | **solo si** el Dashboard está en otro proyecto: su llave service_role |

4. Desde ahora, cada cambio que se suba a `main` se publica solo.

### 3. Primer ingreso

1. Abre la URL del Worker → **Crear cuenta**. Serás el admin.
2. El equipo crea su cuenta; tú los apruebas en tu avatar → *Tu cuenta* → *Acceso* = Equipo.
3. En **Productos**, edita cada producto y elige su **Oferta en el NUCLEA Dashboard**.
4. Cada persona agrega el conector en Claude: Agentes → *Primera vez: conectar Scriptorium a Claude*.

## Desarrollo

```bash
npm install
cp .dev.vars.example .dev.vars   # y llena los valores
npm run dev
npm test && npm run typecheck
```

`public/index.html` se genera desde el prototipo aprobado con `scripts/port.py`; los cambios nuevos se hacen directo en `public/index.html`.
