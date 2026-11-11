export interface Env {
  ASSETS: Fetcher;
  // Supabase de Scriptorium (login y datos del equipo).
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Supabase del NUCLEA Dashboard (para leer el ROAS). Si no se ponen, se usa el mismo de arriba.
  DASH_SUPABASE_URL?: string;
  DASH_SUPABASE_KEY?: string;
  // Clave del conector MCP para Claude (larga y aleatoria).
  MCP_KEY?: string;
}
