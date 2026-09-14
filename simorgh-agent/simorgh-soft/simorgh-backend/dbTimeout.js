// Bounding MySQL calls that can hang instead of failing.
//
// The TPMS database is reached across subnets from inside the container
// network, so a pooled socket can be dropped in transit — by a firewall or a
// NAT table reclaiming an idle flow — without either end being told. Nothing
// in the client notices: mysql2 hands the dead socket to the next request,
// which writes its query and waits for a reply that will never arrive, until
// the query timeout fires. That is what turns one dropped flow into every
// TPMS route answering 500 after exactly TPMS_QUERY_TIMEOUT_MS.
//
// Both halves of the cure need the same primitive — a promise that cannot
// wait forever — so it lives here rather than in either caller.

/** Reject if `promise` has not settled within `ms`. */
export function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** How long a liveness check may take before we call the socket dead. Short
 *  on purpose: a healthy LAN ping is about a millisecond, and the failure this
 *  bounds is one that otherwise hangs for the full query timeout. */
export const MYSQL_PING_TIMEOUT_MS = Number(process.env.MYSQL_PING_TIMEOUT_MS || 5000);
