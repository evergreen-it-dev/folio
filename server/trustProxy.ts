/**
 * TRUST_PROXY → Fastify's `trustProxy`. It decides whether `request.ip`
 * (the key of the login and anonymous-form rate limits) is the TCP peer or the
 * client address a reverse proxy reports in X-Forwarded-For.
 *
 *   unset / false / 0 / no / off   the TCP peer. The default, and what a
 *                                  deployment WITHOUT a proxy must keep: nobody
 *                                  can invent an X-Forwarded-For to dodge limits.
 *   true / yes / on                the proxy sits on a private or loopback address
 *                                  (127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16,
 *                                  169.254/16, fc00::/7) — nginx/Caddy on the same
 *                                  host, Traefik or a proxy container on the docker
 *                                  network. Only a connection FROM such an address
 *                                  is believed, and then only the entry that proxy
 *                                  appended to X-Forwarded-For, never what a client
 *                                  put in front of it.
 *   10.1.2.3, 172.20.0.0/16        explicit proxy addresses/CIDRs (also proxy-addr's
 *                                  names loopback, linklocal, uniquelocal).
 *
 * Fastify 5 never trusts a bare hop count ("1"): that would let a client that
 * reaches the app directly forge its address. So it is refused here, loudly.
 *
 * Without any of this, behind a proxy every visitor shares the proxy's address,
 * and ten sign-ins a minute from ANYONE lock everyone out.
 */
export type TrustProxySetting = false | string[];

const PRIVATE_AND_LOOPBACK = ['loopback', 'linklocal', 'uniquelocal'];

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || ['false', '0', 'no', 'off'].includes(value)) return false;
  if (['true', 'yes', 'on'].includes(value)) return PRIVATE_AND_LOOPBACK;
  if (/^\d+$/.test(value)) {
    throw new Error(`TRUST_PROXY=${value}: a hop count is not supported (a client could forge its address). Use true, or the proxy's address/CIDR list.`);
  }
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}
