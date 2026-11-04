// These headers are commonly added or rewritten by the proxy, not proof of sender intent.
const proxyHeaders = new Set([
  "accept-encoding",
  "connection",
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-ew-via",
  "cf-pseudo-ipv4",
  "cdn-loop",
  "true-client-ip",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);
export function isProxyHeader(name) {
  return proxyHeaders.has(name.toLowerCase());
}
