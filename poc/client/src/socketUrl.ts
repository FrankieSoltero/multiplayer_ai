/** Pure derivation of the WebSocket origin from the page location.
 *
 *  A ws:// socket opened from an https:// page is blocked outright by the
 *  browser, so the scheme must follow the page rather than be hardcoded
 *  (spec §3.3). Deriving it — rather than pinning wss: — is what keeps the
 *  plain-HTTP single-port path working locally.
 *
 *  `protocol` is window.location.protocol (trailing colon included);
 *  `host` is window.location.host (port included when non-default). */
export function socketUrlFor(protocol: string, host: string): string {
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
}
