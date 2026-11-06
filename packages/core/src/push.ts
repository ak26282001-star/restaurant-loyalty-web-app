/** Push services browsers hand out subscriptions for. Sending anywhere else is refused (SSRF protection). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
];

/** True for https endpoints on a known push service, or on a host in `extraHosts` (host[:port], for tests). */
export function isAllowedPushEndpoint(endpoint: string, extraHosts: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return extraHosts.includes(url.host) || PUSH_HOSTS.some((re) => re.test(url.hostname));
}
