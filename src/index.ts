import type { Env } from "./env";
import { approved, currentMember, type Member } from "./auth";
import { db } from "./supabase";
import { cachedRoas, cachedTotals, validRange } from "./roas";
import { handleMcp } from "./mcp";
import { syncProducts } from "./sync";
import {
  CALLBACK_PATH, GcalError, authUrl, checkState, chooseCalendar, deleteEvent, disconnect,
  finishOAuth, listCalendars, loadState, publicStatus, pullEvents, pushEvent,
} from "./gcal";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/health") return json({ ok: true, app: "scriptorium", mcp: true });

    // Conector de Claude (MCP): /mcp/<MCP_KEY> o /mcp con Authorization: Bearer <MCP_KEY>
    const mcp = path.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (mcp) return handleMcp(req, env, mcp[1] ? decodeURIComponent(mcp[1]) : null);

    // Vuelta de Google después de dar permiso al calendario.
    if (path === CALLBACK_PATH) {
      const back = (r: string) => Response.redirect(`${url.origin}/?gcal=${r}#calendario`, 302);
      const err = url.searchParams.get("error");
      if (err) return back(err === "access_denied" ? "denegado" : "error");
      const uid = await checkState(env, url.searchParams.get("state") || "");
      const code = url.searchParams.get("code");
      if (!uid || !code) return back("error");
      const m = await currentMemberById(env, uid);
      if (m?.role !== "admin") return back("error");
      try {
        await finishOAuth(env, url.origin, code);
        ctx.waitUntil(pullEvents(env).catch((e) => console.error("Google Calendar", e instanceof Error ? e.message : e)));
        return back("ok");
      } catch (e) {
        console.error("Google Calendar OAuth", e instanceof Error ? e.message : e);
        return back("error");
      }
    }

    // Datos públicos que necesita la página para iniciar sesión con Supabase.
    if (path === "/api/config") {
      return json({ supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY });
    }

    if (path.startsWith("/api/")) {
      // Mi ficha (la crea la primera vez que alguien entra).
      if (path === "/api/me") {
        const me = await currentMember(req, env, true);
        return me ? json(me) : json({ error: "Inicia sesión" }, 401);
      }

      const me = await currentMember(req, env);
      if (!me) return json({ error: "Inicia sesión" }, 401);
      if (!approved(me)) return json({ error: "Tu acceso está pendiente de aprobación" }, 403);

      // ROAS de los últimos 3 días por producto y país, leído del NUCLEA Dashboard.
      if (path === "/api/roas" && req.method === "GET") {
        return json(await cachedRoas(env, ctx));
      }

      // Ventas y facturación neta del equipo entre dos fechas, para las metas.
      if (path === "/api/ventas" && req.method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!validRange(from, to)) return json({ error: "Fechas inválidas" }, 400);
        return json(await cachedTotals(env, ctx, from as string, to as string));
      }

      // URL del conector MCP para que el equipo lo agregue en Claude.
      if (path === "/api/mcp") {
        const ok = env.MCP_KEY && env.MCP_KEY.length >= 16;
        return json({ url: ok ? `${url.origin}/mcp/${encodeURIComponent(env.MCP_KEY as string)}` : null });
      }

      if (path.startsWith("/api/gcal")) {
        try {
          return await gcalRoute(req, env, url, me);
        } catch (e) {
          if (e instanceof GcalError) return json({ error: e.message }, e.status);
          console.error("Google Calendar", e instanceof Error ? e.message : e);
          return json({ error: "Falló la conexión con Google Calendar" }, 500);
        }
      }

      return json({ error: "Ruta no encontrada" }, 404);
    }
    return env.ASSETS.fetch(req);
  },

  // Cada hora (minuto 15): las ofertas nuevas del Dashboard aparecen como productos.
  // Cada 15 minutos: cambios de Google Calendar → Scriptorium.
  async scheduled(c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pullEvents(env).then((r) => console.log("Google Calendar", JSON.stringify(r))).catch((e) => console.error("Google Calendar", e instanceof Error ? e.message : e)));
    if (c.cron !== "15 * * * *") return;
    ctx.waitUntil(syncProducts(env).then((r) => console.log("Sync productos", JSON.stringify(r))).catch((e) => console.error("Sync productos", e instanceof Error ? e.message : e)));
  },
} satisfies ExportedHandler<Env>;

async function currentMemberById(env: Env, uid: string): Promise<Member | null> {
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return null;
  const r = await db<Member[]>(env, `sc_members?user_id=eq.${uid}&select=user_id,email,name,role`);
  return r.data?.[0] ?? null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
}

/** /api/gcal/*: estado, conectar (admin), elegir calendario (admin), enviar, borrar y traer eventos. */
async function gcalRoute(req: Request, env: Env, url: URL, me: Member): Promise<Response> {
  const path = url.pathname;
  const post = req.method === "POST";
  const admin = me.role === "admin";
  const onlyAdmin = () => json({ error: "Solo un admin puede cambiar la conexión con Google" }, 403);

  if (path === "/api/gcal" && req.method === "GET") return json(publicStatus(env, await loadState(env)));

  if (path === "/api/gcal/connect" && post) {
    if (!admin) return onlyAdmin();
    return json({ url: await authUrl(env, url.origin, me.user_id) });
  }
  if (path === "/api/gcal/disconnect" && post) {
    if (!admin) return onlyAdmin();
    await disconnect(env);
    return json({ ok: true });
  }
  if (path === "/api/gcal/calendars" && req.method === "GET") {
    if (!admin) return onlyAdmin();
    return json({ calendars: await listCalendars(env) });
  }
  if (path === "/api/gcal/calendar" && post) {
    if (!admin) return onlyAdmin();
    const b = await body(req);
    await chooseCalendar(env, String(b.id || ""), String(b.name || ""));
    const r = await pullEvents(env);
    return json({ ok: true, ...r });
  }
  if (path === "/api/gcal/push" && post) {
    const id = String((await body(req)).id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Evento inválido" }, 400);
    return json(await pushEvent(env, id, url.origin));
  }
  if (path === "/api/gcal/delete" && post) {
    const b = await body(req);
    await deleteEvent(env, String(b.gid || ""), b.cal ? String(b.cal) : undefined);
    return json({ ok: true });
  }
  if (path === "/api/gcal/pull" && post) {
    const force = admin && (await body(req)).force === true;
    return json(await pullEvents(env, force ? 0 : 2 * 60 * 1000));
  }
  return json({ error: "Ruta no encontrada" }, 404);
}
