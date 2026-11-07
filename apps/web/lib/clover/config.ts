import "server-only";

export type CloverEnvironment = "sandbox" | "na" | "eu" | "la";

// From Clover's docs: OAuth authorize runs on the dashboard host, token/refresh and REST on the API host.
const OAUTH_HOSTS: Record<CloverEnvironment, string> = {
  sandbox: "https://sandbox.dev.clover.com",
  na: "https://www.clover.com",
  eu: "https://www.eu.clover.com",
  la: "https://www.la.clover.com",
};
const API_HOSTS: Record<CloverEnvironment, string> = {
  sandbox: "https://apisandbox.dev.clover.com",
  na: "https://api.clover.com",
  eu: "https://api.eu.clover.com",
  la: "https://api.la.clover.com",
};

export function cloverEnvironment(): CloverEnvironment {
  const env = (process.env.CLOVER_ENVIRONMENT ?? "sandbox") as CloverEnvironment;
  return env in API_HOSTS ? env : "sandbox";
}

/** Tests point these at a local fake Clover via CLOVER_OAUTH_BASE_URL / CLOVER_API_BASE_URL. */
export function oauthHost(env: CloverEnvironment) {
  return process.env.CLOVER_OAUTH_BASE_URL ?? OAUTH_HOSTS[env];
}
export function apiHost(env: CloverEnvironment) {
  return process.env.CLOVER_API_BASE_URL ?? API_HOSTS[env];
}

export function cloverAppCredentials() {
  const appId = process.env.CLOVER_APP_ID;
  const appSecret = process.env.CLOVER_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export function cloverConfigured() {
  return Boolean(cloverAppCredentials() && process.env.CLOVER_WEBHOOK_AUTH_CODE && process.env.TOKEN_ENCRYPTION_KEY);
}

export function siteUrl(fallbackOrigin: string) {
  return process.env.NEXT_PUBLIC_SITE_URL ?? fallbackOrigin;
}
