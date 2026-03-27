/**
 * hlc.js — Hybrid Logical Clock (HLC) for data-api
 *
 * Isomorphic: zero Node-specific imports. Runs in browser, Node, and edge runtimes.
 *
 * HLC state: { ms: number, seq: number, node: string }
 *
 * Encoded as a zero-padded hex string:
 *   '<13-hex-ms>-<6-hex-seq>-<node>'
 *
 * - 13 hex digits for ms: covers ~8925 years from epoch
 * - 6 hex digits for seq: up to 16,777,215 events per millisecond
 * - node: arbitrary string identifier (UUID short form recommended)
 *
 * Lexicographic ordering of the encoded string preserves causal ordering,
 * making it safe to use as a NoSQL sort key or filter comparator.
 *
 * References:
 *   Kulkarni et al. "Logical Physical Clocks" (HLC paper)
 *   https://cse.buffalo.edu/tech-reports/2014-04.pdf
 */

const MS_PAD = 13;  // 13 hex digits = 2^52 ms ≈ 142 million years, well beyond epoch range
const SEQ_PAD = 6;  // 6 hex digits = 16,777,215 events per ms

/**
 * Encode an HLC state object to a hex string.
 * @param {{ ms: number, seq: number, node: string }} state
 * @returns {string}
 */
function encode(state) {
  const msPart = Math.floor(state.ms).toString(16).padStart(MS_PAD, '0');
  const seqPart = Math.floor(state.seq).toString(16).padStart(SEQ_PAD, '0');
  return `${msPart}-${seqPart}-${state.node}`;
}

/**
 * Decode an encoded HLC string back to a state object.
 * @param {string} str
 * @returns {{ ms: number, seq: number, node: string }}
 */
function decode(str) {
  const first = str.indexOf('-');
  const second = str.indexOf('-', first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`HLC.decode: invalid format "${str}"`);
  }
  const ms = parseInt(str.slice(0, first), 16);
  const seq = parseInt(str.slice(first + 1, second), 16);
  const node = str.slice(second + 1);
  return { ms, seq, node };
}

/**
 * The minimum possible HLC string — used as an initial client clock meaning
 * "I have seen nothing yet". All real clocks compare greater than this.
 * @returns {string}
 */
function zero() {
  return `${'0'.repeat(MS_PAD)}-${'0'.repeat(SEQ_PAD)}-00000000`;
}

/**
 * Tick: advance the local clock for a send or local event.
 *
 * @param {string} current — encoded current local HLC
 * @param {number} wallMs  — current wall clock in ms (Date.now())
 * @returns {string}       — new encoded HLC
 */
function tick(current, wallMs) {
  const c = typeof current === 'string' ? decode(current) : current;
  const wall = Math.floor(wallMs);
  if (wall > c.ms) {
    return encode({ ms: wall, seq: 0, node: c.node });
  }
  return encode({ ms: c.ms, seq: c.seq + 1, node: c.node });
}

/**
 * Recv: advance the local clock upon receiving a remote message.
 * Advances beyond both the local clock and the received remote clock.
 *
 * @param {string} local   — encoded local HLC
 * @param {string} remote  — encoded remote HLC received in a message
 * @param {number} wallMs  — current wall clock in ms
 * @returns {string}       — new encoded HLC
 */
function recv(local, remote, wallMs) {
  const l = typeof local === 'string' ? decode(local) : local;
  const r = typeof remote === 'string' ? decode(remote) : remote;
  const wall = Math.floor(wallMs);

  const maxMs = Math.max(l.ms, r.ms, wall);

  if (maxMs === wall && wall > l.ms && wall > r.ms) {
    return encode({ ms: wall, seq: 0, node: l.node });
  }
  if (maxMs === l.ms && l.ms === r.ms) {
    return encode({ ms: maxMs, seq: Math.max(l.seq, r.seq) + 1, node: l.node });
  }
  if (maxMs === l.ms) {
    return encode({ ms: maxMs, seq: l.seq + 1, node: l.node });
  }
  // maxMs === r.ms
  return encode({ ms: maxMs, seq: r.seq + 1, node: l.node });
}

/**
 * Merge: return the greater of two encoded HLC strings.
 * Used to determine which revision wins in a conflict.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function merge(a, b) {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Compare two encoded HLC strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compare(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Create a new HLC state initialised to wall clock time with seq 0.
 * Requires a node identifier — pass a UUID or any stable unique string.
 *
 * @param {string} nodeId
 * @param {number} [wallMs]
 * @returns {string}
 */
function create(nodeId, wallMs) {
  const ms = wallMs !== undefined ? Math.floor(wallMs) : 0;
  return encode({ ms, seq: 0, node: nodeId });
}

const HLC = { encode, decode, zero, tick, recv, merge, compare, create };

export default HLC;
