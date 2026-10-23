// This is a passive hostname alternative in linkify-it's URL recognition regex,
// not a local-service endpoint. Ignore only this exact expression during static
// endpoint checks; real local URLs and every network API remain forbidden.
export function endpointScanSource(source) {
  return source.replaceAll('`(?:localhost|${this.get_ipv6_url_host().source}|',
    '`(?:${this.get_ipv6_url_host().source}|');
}

// KaTeX's Parser.fetch() reads a TeX token, not a URL. Recognize actual global
// network APIs, without confusing object methods or method declarations with
// the browser's fetch function. Explicit window/self/globalThis.fetch is banned.
export const PUBLIC_NETWORK_PATTERN = /(?<![\w.])fetch\s*\((?!\s*\)\s*\{)|\b(?:window|self|globalThis)\s*\.\s*fetch\s*\(|XMLHttpRequest|new\s+WebSocket|new\s+EventSource/;
