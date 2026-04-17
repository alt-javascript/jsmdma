/**
 * textMerge.js — Line-level 3-way text merge
 *
 * Isomorphic: zero Node-specific imports.
 *
 * Performs a conservative 3-way line merge of base/local/remote strings.
 * If the two change-sets (base→local and base→remote) produce non-overlapping
 * hunks, the merge is applied automatically and { merged, autoMerged: true }
 * is returned.  If any pair of hunks overlaps the merge is abandoned and
 * { merged: null, autoMerged: false } is returned — the caller must fall back
 * to its own conflict-resolution strategy (e.g. HLC winner).
 *
 * Algorithm overview
 * ──────────────────
 * 1. Split all three strings into line arrays.
 * 2. Compute a Myers-style LCS diff between base lines and each side's lines,
 *    producing an array of hunks: { baseStart, baseEnd, lines }.
 * 3. Check whether any local hunk and any remote hunk share at least one base
 *    line index (overlap check).  If they do → autoMerged: false.
 * 4. If no overlap, replay all hunks against the base lines in reverse order
 *    (so that earlier indices stay valid as we splice) and join with '\n'.
 *
 * Edge cases handled
 * ──────────────────
 * - null / undefined inputs → treated as empty string
 * - Trailing newline: if the original non-empty base, local, or remote string
 *   ends with '\n', the merged result ends with '\n'
 * - Pure-whitespace lines are treated as ordinary lines (no special casing)
 * - Idempotent deletion: if both sides delete the same line the result is a
 *   single deletion (both hunks agree, so no overlap)
 *
 * @param {string|null|undefined} base   — common ancestor text
 * @param {string|null|undefined} local  — locally-modified text
 * @param {string|null|undefined} remote — remotely-modified text
 *
 * @returns {{ merged: string|null, autoMerged: boolean }}
 *   autoMerged:true  → merged contains the 3-way-merged text
 *   autoMerged:false → merged is null; caller should use another strategy
 */

/**
 * Split text into lines.  An empty/null/undefined value yields [].
 * Trailing newline is tracked separately — it does NOT become an empty last
 * element in the array so that diff logic stays clean.
 *
 * @param {string|null|undefined} text
 * @returns {{ lines: string[], trailingNewline: boolean }}
 */
function splitLines(text) {
  if (text == null || text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const raw = trailingNewline ? text.slice(0, -1) : text;
  return { lines: raw.split('\n'), trailingNewline };
}

/**
 * Longest Common Subsequence length matrix — O(m*n) time and space.
 * Returns the lcs table so we can backtrack the diff.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]}
 */
function lcsTable(a, b) {
  const m = a.length;
  const n = b.length;
  // Allocate as flat array for perf; access as table[i*(n+1)+j]
  const table = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      table[i * (n + 1) + j] =
        a[i - 1] === b[j - 1]
          ? table[(i - 1) * (n + 1) + (j - 1)] + 1
          : Math.max(table[(i - 1) * (n + 1) + j], table[i * (n + 1) + (j - 1)]);
    }
  }
  return table;
}

/**
 * Compute the edit script (hunks) from base → modified using LCS backtracking.
 *
 * A hunk represents a contiguous replaced region in base:
 *   { baseStart: number, baseEnd: number, lines: string[] }
 *
 * baseStart..baseEnd (exclusive) is the range of base lines being replaced by
 * `lines`.  A pure insertion has baseStart === baseEnd (zero-length range).
 * A pure deletion has lines === [].
 *
 * @param {string[]} base
 * @param {string[]} modified
 * @returns {Array<{ baseStart: number, baseEnd: number, lines: string[] }>}
 */
function computeHunks(base, modified) {
  const m = base.length;
  const n = modified.length;
  const table = lcsTable(base, modified);

  // Backtrack to get the sequence of diff operations
  // ops: { type: 'keep'|'insert'|'delete', baseLine?: number, modLine?: string }
  const ops = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && base[i - 1] === modified[j - 1]) {
      ops.push({ type: 'keep', baseLine: i - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i * (n + 1) + (j - 1)] >= table[(i - 1) * (n + 1) + j])) {
      ops.push({ type: 'insert', modLine: modified[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', baseLine: i - 1 });
      i--;
    }
  }

  ops.reverse();

  // Collapse consecutive non-keep ops into hunks
  const hunks = [];
  let opIdx = 0;

  while (opIdx < ops.length) {
    const op = ops[opIdx];

    if (op.type === 'keep') {
      opIdx++;
      continue;
    }

    // Start of a hunk
    // Find the base index range and collect replacement lines
    let baseStart = null;
    let baseEnd   = null;
    const hunkLines = [];

    while (opIdx < ops.length && ops[opIdx].type !== 'keep') {
      const cur = ops[opIdx];
      if (cur.type === 'delete') {
        if (baseStart === null) baseStart = cur.baseLine;
        baseEnd = cur.baseLine + 1;
      } else {
        // insert — no base line consumed
        hunkLines.push(cur.modLine);
      }
      opIdx++;
    }

    // A pure insertion lands between two keep ops; anchor it to the next
    // base line index (or end of base).  Find insertion point from surrounding keep ops.
    if (baseStart === null) {
      // Pure insertion — find where in the base sequence this falls
      // Look backward for the last keep op
      let insertPoint = 0;
      for (let k = opIdx - 1; k >= 0; k--) {
        if (ops[k] && ops[k].type === 'keep') {
          insertPoint = ops[k].baseLine + 1;
          break;
        }
      }
      baseStart = insertPoint;
      baseEnd   = insertPoint;
    }

    // Interleave: the replacement lines include the inserted lines.
    // Re-collect in order (deletions and insertions may interleave).
    // We've already collected hunkLines above (insertion lines only).
    // The final replacement is: inserted lines (deletions are just removed).
    hunks.push({ baseStart, baseEnd, lines: hunkLines });
  }

  return hunks;
}

/**
 * Check whether two sets of hunks have any overlapping base ranges.
 * Hunks are considered overlapping if their [baseStart, baseEnd) ranges
 * share at least one base line index.  A zero-length (pure insertion) hunk
 * at position X overlaps with a deletion hunk that includes line X.
 *
 * @param {Array<{ baseStart: number, baseEnd: number }>} hunksA
 * @param {Array<{ baseStart: number, baseEnd: number }>} hunksB
 * @returns {boolean}
 */
function haveOverlap(hunksA, hunksB) {
  for (const a of hunksA) {
    for (const b of hunksB) {
      const aStart = a.baseStart;
      const aEnd   = a.baseEnd;
      const bStart = b.baseStart;
      const bEnd   = b.baseEnd;

      // Both are pure insertions at the same point → same anchor but no shared lines
      if (aStart === aEnd && bStart === bEnd) {
        if (aStart === bStart) return true; // concurrent insertions at same point
        continue;
      }

      // Standard interval overlap check: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅
      if (aStart < bEnd && bStart < aEnd) return true;

      // Pure insertion inside a deletion range
      if (aStart === aEnd && aStart > bStart && aStart < bEnd) return true;
      if (bStart === bEnd && bStart > aStart && bStart < aEnd) return true;
    }
  }
  return false;
}

/**
 * Apply a set of non-overlapping hunks to base lines and return the result.
 * Hunks must be sorted by baseStart ascending (computeHunks guarantees this
 * via the backtracking order).
 *
 * @param {string[]} baseLines
 * @param {Array<{ baseStart: number, baseEnd: number, lines: string[] }>} hunks
 * @returns {string[]}
 */
function applyHunks(baseLines, hunks) {
  // Apply in reverse so indices don't shift under us
  const result = baseLines.slice();
  const sorted = hunks.slice().sort((a, b) => b.baseStart - a.baseStart);

  for (const hunk of sorted) {
    result.splice(hunk.baseStart, hunk.baseEnd - hunk.baseStart, ...hunk.lines);
  }

  return result;
}

/**
 * Merge two sets of non-overlapping hunks against the base lines.
 * First applies local changes then remote changes (both are non-overlapping
 * with each other, so order does not matter for correctness; we apply them
 * in a single sorted pass).
 *
 * @param {string[]} baseLines
 * @param {Array<{ baseStart: number, baseEnd: number, lines: string[] }>} localHunks
 * @param {Array<{ baseStart: number, baseEnd: number, lines: string[] }>} remoteHunks
 * @returns {string[]}
 */
function mergeHunks(baseLines, localHunks, remoteHunks) {
  // Deduplicate identical hunks (e.g. both sides deleted the same line)
  const all = [...localHunks];

  for (const rh of remoteHunks) {
    const duplicate = localHunks.some(
      (lh) =>
        lh.baseStart === rh.baseStart &&
        lh.baseEnd === rh.baseEnd &&
        lh.lines.join('\n') === rh.lines.join('\n'),
    );
    if (!duplicate) all.push(rh);
  }

  return applyHunks(baseLines, all);
}

/**
 * Public API.
 *
 * @param {string|null|undefined} base
 * @param {string|null|undefined} local
 * @param {string|null|undefined} remote
 * @returns {{ merged: string|null, autoMerged: boolean }}
 */
export default function textMerge(base, local, remote) {
  const { lines: baseLines }   = splitLines(base);
  const { lines: localLines }  = splitLines(local);
  const { lines: remoteLines, trailingNewline: remoteTrail } = splitLines(remote);
  const { trailingNewline: localTrail }  = splitLines(local);
  const { trailingNewline: baseTrail }   = splitLines(base);

  // If either side equals base, the other side wins trivially
  if (local === base || local == null && base == null) {
    return { merged: remote ?? '', autoMerged: true };
  }
  if (remote === base || remote == null && base == null) {
    return { merged: local ?? '', autoMerged: true };
  }
  // If both sides are identical (concurrent same edit) → pick either
  if (local === remote) {
    return { merged: local, autoMerged: true };
  }

  const localHunks  = computeHunks(baseLines, localLines);
  const remoteHunks = computeHunks(baseLines, remoteLines);

  // No hunks on either side means the texts are equal to base — handled above.
  // If one side has no hunks it's a no-op; the other side's changes win.
  if (haveOverlap(localHunks, remoteHunks)) {
    return { merged: null, autoMerged: false };
  }

  const mergedLines = mergeHunks(baseLines, localHunks, remoteHunks);
  const trailingNewline = localTrail || remoteTrail || baseTrail;
  const merged = mergedLines.join('\n') + (trailingNewline ? '\n' : '');

  return { merged, autoMerged: true };
}
