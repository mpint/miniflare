export const CoreHeaders = {
  CUSTOM_SERVICE: "MF-Custom-Service",
  ORIGINAL_URL: "MF-Original-URL",
  ERROR_STACK: "MF-Experimental-Error-Stack",
  ROUTE_OVERRIDE: "MF-Route-Override",
  CUSTOM_EVENT: "MF-Custom-Event",
} as const;

export const CoreBindings = {
  SERVICE_LOOPBACK: "MINIFLARE_LOOPBACK",
  SERVICE_USER_ROUTE_PREFIX: "MINIFLARE_USER_ROUTE_",
  SERVICE_USER_FALLBACK: "MINIFLARE_USER_FALLBACK",
  TEXT_CUSTOM_SERVICE: "MINIFLARE_CUSTOM_SERVICE",
  JSON_CF_BLOB: "CF_BLOB",
  JSON_ROUTES: "MINIFLARE_ROUTES",
  JSON_LOG_LEVEL: "MINIFLARE_LOG_LEVEL",
  DATA_LIVE_RELOAD_SCRIPT: "MINIFLARE_LIVE_RELOAD_SCRIPT",
} as const;

export enum LogLevel {
  NONE,
  ERROR,
  WARN,
  INFO,
  DEBUG,
  VERBOSE,
}
