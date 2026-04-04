# ADR-005: Planner document structure — sparse map keyed by ISO date

- **Status:** Accepted
- **Date:** 2026-03-28
- **Deciders:** Craig Parravicini

## Context

Year planner data is naturally hierarchical: one planner containing data for up to 366 days, each day having a small number of fields (`tp`, `tl`, `col`, `notes`, `emoji`). The storage granularity and document shape determine how field-level conflict resolution (dot-path fieldRevs, ADR-002) addresses individual day fields.

Options considered:

1. **One document per day in a `days` collection** — Maximum merge granularity; each day is independently syncable. Heavy storage overhead: 366 documents per planner per year, most of which are empty for sparse planners.

2. **One document per month** — Intermediate granularity. Still 12 documents; partial month conflicts remain at the whole-month key level without dot-path support.

3. **One document per planner with a `days` array** — Compact. Arrays are not directly dot-path addressable by their semantic content (ISO date) — only by numeric index, which shifts when days are inserted or removed.

4. **One document per planner with `days` as a sparse map keyed by ISO date** — Compact and dot-path addressable at the individual day-field level.

## Decision

One document per planner. Document structure:

```json
{
  "meta": { "name": "Year Plan 2026", "color": "blue" },
  "days": {
    "2026-03-28": { "tp": 3, "tl": 5, "col": "#ff0000", "notes": "standup", "emoji": "🚀" },
    "2026-03-29": { "tp": 0, "tl": 2 }
  }
}
```

`days` is a **sparse plain object** keyed by ISO date string (`YYYY-MM-DD`). Only days with at least one field value are present. Days with no data are absent entirely — no null entries, no placeholder objects.

This gives individual day fields their own dot-path addresses:

```
days.2026-03-28.tp     → HLC of last edit to "total pomodoros" for March 28
days.2026-03-28.notes  → HLC of last edit to notes for March 28
```

Storage namespace: one planner per document in `{userId}:year-planner:planners`. The document key is the planner UUID (see ADR-006).

## Consequences

**Positive:**
- Each day field is independently addressable and resolvable at the dot-path level — two devices editing different days of the same planner never conflict.
- Sparse map keeps storage small: a planner with data on 30 of 365 days stores only 30 entries.
- Human-readable at the API level: ISO date keys are self-documenting.
- `changesSince` returns the full planner document on any change, but a full-year planner is bounded at approximately 50 KB — a single HTTP response with no pagination needed.

**Negative:**
- `changesSince` returns the full document even if only one day changed. No surgical per-day pull. Acceptable for the planner use case; revisit if multi-year planners are introduced.
- The sparse map requires the client to initialise a day object before writing any field to it (`days["2026-03-28"] = days["2026-03-28"] || {}`). Forgetting this collapses the day entry.

**Risks:**
- ISO date keys with hyphens (`-`) are not path separators in the dot-path encoding; they are valid key characters. However, years that use `.` in their keys would need percent-encoding. The planner's ISO date format does not use dots, so no encoding is needed for day keys.
