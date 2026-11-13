export interface Env {
  ASSETS: Fetcher;
  // Supabase de Scriptorium (login y datos del equipo).
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Supabase del NUCLEA Dashboard (para leer el ROAS). Si no se ponen, se usa el mismo de arriba.
  DASH_SUPABASE_URL?: string;
  DASH_SUPABASE_KEY?: string;
  // Fecha desde la que cuenta el ROAS (YYYY-MM-DD). La ventana es de 3 días pero no empieza antes.
  ROAS_START?: string;
  // Clave del conector MCP para Claude (larga y aleatoria).
  MCP_KEY?: string;
  // Google Calendar (cliente OAuth "Aplicación web" del proyecto de Google Cloud).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Zona horaria de las reuniones (por defecto America/Bogota).
  GCAL_TZ?: string;
}
