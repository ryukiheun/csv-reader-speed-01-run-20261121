# DESIGN — csv-reader-speed-01-run-20261121

A fast drop-in for csv-reader 1.0.0. `solve.js` exports `run(input)` and
returns `{columns, rows, errors}` identical as a JSON value to
csv-reader 1.0.0 for every input. No dependencies, no cache between
cases, no clock, no randomness, no regular expressions, no whole-text
split. ES2020-or-earlier features only in `solve.js` (the driver
`main.ts` is the kit's TypeScript, copied unchanged from the kit
baseline).

Oracle (the definition of correct): csv-reader 1.0.0, `kit/program/
generator/oracle.js` (sha256 `af530e37…6805`, full hash in
`verify/REPORT.md`), calling the vendored reader `kit/program/
generator/vendor/csv-reader/index.js` (sha256 `40cbf19b…32fdf0`,
identical in `kit/baselines/csv-reader/vendor/`). Sources for the
numbers in this file: `kit/competition.yaml` (rules, scoring, limits),
`kit/rules/instance.yaml` (sandbox), `kit/program/generator/subject/
csv-cases.mjs` (generator parameters).

## Goals / Non-Goals

Measurable success criteria (the entry passes iff all hold):

1. **Correctness.** Practice set 6/6, edge suite 105/105, fuzz
   12,000/12,000, held-out set (different generator seed) 6/6 — every
   answer identical to the oracle as a JSON value (canonical compare:
   object keys sorted, strings compared code unit for code unit;
   `verify/canon.mjs`). The shipped `main.ts` run end to end agrees
   6/6 as well.
2. **Speed (canonical).** On the practice set, the trimmed mean of
   the 9 timed rounds' total solve CPU (1 untimed warmup round first,
   `taskset -c 0`, `--no-incremental-marking`, net of the null-entry
   control) is at least 3x lower than the baseline's: baseline CPU ÷
   entry CPU ≥ 3. Measured: **3.2x** (see Speed). Per-case speedups
   are diagnostic only and are not criteria — the slowest practice
   case measures 2.6x.
3. **Qualification gate (kit rule, not ours).** A reward needs a CPU
   time faster than csv-reader 1.0.0, the house baseline, in the final
   heat at 95% confidence, one-sided, over the repeated timed runs
   (`competition.yaml`). Local evidence: the paired one-sided 95%
   lower bound on the per-round total difference is 278.5 ms > 0 (see
   Speed). The server heat re-tests this on the scored set; the local
   test is evidence, not the verdict.
4. **Prize line (not a design criterion).** Places go by CPU time,
   least first; the paid line is the top 10. 176 submissions were
   counted by the API on 2026-11-21 (afternoon KST). A top-10 place
   cannot be measured locally and is not claimed.

- Non-Goals: no change to the driver (`main.ts`, copied from the kit
  baseline); no new output format; no memory optimisation beyond
  staying inside the 1024 MB cap (peak memory is not scored);
  no support for inputs outside `{text, header}`.

Input domain: `run()` needs an object input (`null`/`undefined`
input throws when `input.text` is read). `input.text` is
`String()`-coerced (`123` → `"123"`, `null` → `"null"`,
`undefined` → `"undefined"`). `header` counts only when it is
`=== true` (`1`, `0`, `null`, `"true"` all count as false). Extra
keys are ignored.

## Algorithm

State: one cursor `i` advances left to right over the text; some
spans are re-scanned (break counting inside quotes, CR normalisation
inside quotes, unterminated re-read). Shared mutable state: the
record being parsed, `recLine`/`recRow`; and the scratch outputs of
`unquoted()`, `ufValue`/`ufTerm`/`ufNext`, which live for one field
call and are read immediately by the caller. `finish()` is the only
place that turns parsed fields into `columns`/`rows`/errors (below).

Main loop — one record per iteration, in this order:

1. `i` starts at 0, or 1 when the text starts with U+FEFF (one
   leading BOM is dropped; a second BOM is a literal character).
   `line` starts at 1.
2. Blank-line skip (repeated): a lone LF consumes 1 char and `line++`;
   a CRLF consumes 2 chars and `line++`. A line holding only lone
   CRs is **not** skipped — it is parsed as a record (see the
   `['']`-drop below). If `i` reaches the end, stop.
3. Freeze the record: `recLine = line`; `recRow = null` when this is
   the header record (header true and no real record yet), else
   `rows.length`.
4. Probe the record's first line, bounded to that line: `nl` is the
   next LF (or end of text); `contentEnd` is the line end excluding
   a trailing CR of a CRLF. Slice the line out once (`probe`) and
   test the slice for `"` and for `\r`. (An earlier version searched
   with an unbounded `indexOf('"', i)`, which scanned to the end of
   the text on quoteless input — one end-of-text scan per record,
   measured superlinear, fixed in this version; see Risks.)
   A quoted field may run past this first line; that only sends the
   record to the slow path.
5. Fast path (probe holds no `"` and no `\r`): `fields =
   probe.split(',')`; `i` moves past the line break (or to end of
   text); `line++` once per fast-path record (unobservable when the
   record is the last one with no terminator — the loop ends and
   `line` is never read again). `finish(fields, false)`.
6. Slow path (anything else): parse field by field until a field
   ends at a line break or end of text, then `finish(fields,
   anyQuoted)`. Field entry condition: a field is quoted iff its
   first character is `"`; otherwise it is unquoted (a `"` later in
   the field is literal).
7. After the loop, if `header` is true and no real record was ever
   seen, `columns = []`.

### Slow path — fields

- **Unquoted field** (`unquoted(from)`): one `indexOf(',', pos)` per
  field. The native scan stops at the next comma; in the usual case
  that comma sits inside this record, but it can run past a line
  break when the field ends at LF before any comma follows — the
  field still ends at the LF, and the comma found is ignored for
  this field. The character-by-character scan below never goes past
  the field's end: it stops at the first LF or CR, or at that comma.
  A CR not followed by LF is dropped with a `stray_cr` error and the
  field continues past it; the comma found by the first scan is
  still the bound, because no comma sits before that CR (the guard
  is: the CR is only dropped when it lies before the found comma).
  A CR followed by LF, or an LF, ends the record and advances `line`
  by one. A comma ends the field. End of text ends the record.
- **Quoted field**: the closing quote is found with `indexOf('"')`,
  skipping `""` pairs (each collapses to one `"`). The search is not
  bounded by the line: it runs to the end of the text when the quote
  never closes. Line breaks inside the quotes are counted over the
  span between the opening and closing quotes (each LF, CRLF and
  lone CR counts one) and added to `line`; when the span holds a CR,
  `normalizeCR()` rewrites each CRLF or lone CR to one LF (a second
  pass over the span, only in that case).
- **Junk after the closing quote**: the next character decides, with
  no scan in the common cases — comma ends the field, LF or CRLF
  ends the record (`line++` once), end of text ends the record.
  Anything else, including a lone CR, goes through the unquoted
  scanner: a lone CR there is dropped with `stray_cr`, the junk runs
  to the next comma or line break, and `quote_junk` fires only when
  the junk holds ≥ 1 kept character (dropped CRs do not count).
  `quote_junk` fires on 284 fields across the 6 practice cases
  (63,692 rows), so the no-scan dispatch handles the overwhelming
  majority of quoted fields.
- **Unterminated quote**: when no un-doubled quote exists anywhere
  after the opening quote, the quote is a literal character. An
  `unterminated_quote` error is pushed first, then the field is
  re-read as unquoted starting at the opening quote (the re-read
  treats `"` as literal, counts line breaks as the unquoted scanner
  does, and ends at the next comma, line break, or end of text).

### Records, width, errors

- `finish(fields, anyQuoted)`: a record that parses to exactly `['']`
  with no quoted field in it is not a record (it is a line of nothing
  but dropped CRs); its errors stay, its row is not consumed, and
  its line advances by one only when the dropped line ends with a
  CRLF — a lone-LF line never reaches here (it is blank-skipped),
  and a dropped line ending at end of text advances nothing.
  Otherwise the first real record sets the width: when `header` is
  true it becomes `columns` (never padded or cut, no short/long
  error); when false it is the first row. Later records are padded
  with `''` (`short_row`, with `fields`: the pre-padding field
  count) or cut (`long_row`, with `extra`: the pre-cut fields) to
  the width.
- Every error has at least `{code, line, row}`; `short_row` adds
  `fields`, `long_row` adds `extra`. Errors come in encounter order:
  `stray_cr` / `unterminated_quote` when met, `quote_junk` when its
  field ends (after any `stray_cr` inside the junk), `short_row` /
  `long_row` when the record ends. `line` is the 1-based line the
  record starts on. `row` is the record's index in `rows`, except
  the header record, whose `row` is null.
- Line counting: LF and CRLF outside quotes count one line each; a
  stray CR outside quotes counts no line; every LF, CRLF and lone CR
  inside quotes counts one line; skipped blank lines count one line.
  "Line" here means a physical line; "record" means one parsed row.

## Constants and symbols — definitions

There are **no tuned numeric constants** in this entry: no thresholds,
no weights, no clamps, no magic numbers chosen by hand. The only
named constants are character codes and terminator tags. (Unnamed
literals such as `+1`/`+2` offsets, the `-1` "not found" sentinel and
`''` exist in the code; they are not tuned values.)

| Symbol | Value | Definition | Source |
|---|---|---|---|
| `CHAR_QUOTE` | 34 | `"` — opens/closes a quoted field; `""` inside is one quote (unit: one UTF-16 code unit) | CSV syntax, spec |
| `CHAR_COMMA` | 44 | `,` — field separator (unit: one UTF-16 code unit) | CSV syntax, spec |
| `CHAR_LF` | 10 | `\n` — record terminator, with or without a preceding CR (unit: one UTF-16 code unit) | spec |
| `CHAR_CR` | 13 | `\r` — part of CRLF, or a stray CR outside quotes, or one LF inside quotes (unit: one UTF-16 code unit) | spec |
| `CHAR_BOM` | 0xFEFF | U+FEFF — dropped once, only at the very start of the text (unit: one UTF-16 code unit) | spec |
| `TERM_COMMA` | 0 | internal tag: field ended at a comma, read the next field (internal enum, no unit) | internal only |
| `TERM_EOL` | 1 | internal tag: field ended at a line break, the record ends (internal enum, no unit) | internal only |
| `TERM_EOF` | 2 | internal tag: field ended at end of text, the record ends (internal enum, no unit) | internal only |

No guard/clamp exists anywhere, so the "guard applies to every
branch" check is inapplicable here (there is nothing to bypass), not
vacuous by wordplay: the entry has no branch whose behaviour depends
on a threshold.

## Edge cases — input condition → behaviour

Behaviour summary (the full 105-case list, each case checked against
the oracle, is in `verify/REPORT.md`; `H` = `header`):

| Input condition | Behaviour |
|---|---|
| `text` is `''`, or only `'\uFEFF'` | no records; `columns` `[]` if H else `null`, `rows` `[]`, no errors |
| `'\uFEFF\uFEFFa\n'` | only the first BOM is dropped; the second is a literal field character |
| only blank lines (`\n`, `\r\n`) | skipped, each counts one line; no records, no errors |
| LF / CRLF / mixed LF/CRLF line endings | each ends a record and counts one line |
| lone CR inside an unquoted field (`a\rb`) | CR dropped, `stray_cr` (record-start line, current row), field continues as `ab`; the CR counts no line |
| lone CR inside quotes (`"a\rb"`) | becomes LF, field `a\nb`; counts one line |
| CRLF / lone CR inside quotes | each becomes one LF; each counts one line |
| a line of only lone CRs (`\r`, `\r\r`, `\r\r\n`) | parses as one field `['']` with no quoted field → not a record; `stray_cr` error(s) stay; the row does not advance; the line advances by one only when the line ends with CRLF (`\r\r\n` is one `stray_cr`: the second CR is the CR of the CRLF) |
| `\ra\n`, `\r\ra\n` | field starts with a CR, so it is unquoted: CR(s) dropped with `stray_cr`, field is `a` |
| `\r""\n` | field starts with a CR, so it is unquoted: CR dropped, field is the literal two characters `""` |
| `""\n` | a real record `[""]` — a quoted empty field is not dropped |
| `""x`, `"a"kg`, `"a" ` | junk appended as-is; `quote_junk` (junk ≥ 1 kept char) |
| `"a"\r` at EOF, `"a"\r\n` | junk is only a dropped CR / a CRLF record terminator: no `quote_junk`; the first also emits `stray_cr` |
| `"a"\rx`, `"a"x\ry` | junk continues past a dropped CR; `stray_cr` then `quote_junk`, in that order |
| `"a"x"y` | quotes inside junk are literal: field `ax"y` + `quote_junk` |
| `"ab` at EOF / `"ab\ncd\n` | no closing quote anywhere after: `unterminated_quote`, then re-read as unquoted from the opening quote (`"ab`, then `cd` as the next record) |
| `"ab\nx"y\n` | the closing quote is found across the line break: field `ab\nxy` + `quote_junk` (the closing-quote search runs to end of text, not to end of line) |
| `"a""b"`, `"ab""c"d` | `""` collapses to one quote; a `"` followed by anything else closes the field |
| `"a""` at EOF | the `""` is an escaped quote, then EOF: unterminated, re-read gives field `"a""` |
| quote inside an unquoted field (`x"y`) | literal character, no error |
| field starting with a space (`"a" , "b"`) | the second field is unquoted (` "b"` literal) — a field is quoted only when its first character is `"` |
| short row (`a,b,c` then `d`, H) | row padded to `["d","",""]`, `short_row` with `fields: 1` |
| long row (`a,b` then `c,d,e,f`, H) | row cut to `["c","d"]`, `long_row` with `extra: ["e","f"]` |
| header record itself | never padded/cut, never a short/long error; it sets the width |
| `header` is `1`, `0`, `null` | treated as false (only `=== true` counts) |
| `text` is a number / `null` / `undefined` | `String(input.text)` is parsed (`"123"`, `"null"`, `"undefined"`) |
| trailing comma at EOF (`a,`) | an empty field is read after it: `["a",""]` |
| last line break missing (`a\nb`) | the last record still counts |
| `,` alone on a line | record `["",""]` |
| non-ASCII fields (`Zürich`, `東京`, emoji) | kept as UTF-16 code units, never converted |
| unterminated quote near the end, tail records with no quotes | the record holding the unterminated quote is re-read as unquoted; later records parse normally (the generator's unterminated-tail shape) |

## Alternatives considered

- **Char-by-char scan (the baseline)**: simplest, but one operation
  per character; measured 541.5 ms of solve CPU (trimmed mean) for
  the 6 practice cases against the entry's 171.6 ms. Rejected for
  speed.
- **Minimal patch of the baseline** (keep its loop, change only the
  string building, e.g. accumulate fields in an array and join):
  the baseline's loop *is* the parser — per-character dispatch,
  per-character `+=`, and the error bookkeeping all live in it — so
  a patch that keeps the loop keeps the cost driver. Not measured
  (no variant was built); rejected on that structural ground, not on
  a speed claim.
- **Three `indexOf` calls per unquoted field** (`,`, `\n`, `\r`):
  the first working version. Replaced by one `indexOf(',')` plus
  the scan to that comma — two fewer native calls per field. The
  old version's numbers are withdrawn with the old bench runs (its
  raw data is lost); no speedup is claimed for this change alone.
- **Regular expressions**: not measured and not used. The parser is
  a state machine over broken rows with per-record error positions;
  a regex would still need the same position tracking, so it was
  rejected on design grounds, not on a speed claim.
- **Whole-text `split`**: a design choice, not an external rule —
  the kit requires each case to be answered alone with nothing cached
  from one case to the next (`competition.yaml`); it does not forbid
  splitting one case's text. A split is used only on one
  already-isolated plain line (the fast path), never on the whole
  text, because quoted fields hold commas and span lines.
- **Per-line `split(',')` for every record**: impossible — quoted
  fields hold commas and span lines. Used only where the probe
  proves the line holds no quote and no CR (other than a CRLF at
  its end).
- **Caching across cases**: forbidden by the kit (each case answered
  alone, nothing cached from one case to the next); not used.

## Verification

Full detail, scripts, hashes and logs: `verify/REPORT.md`.
Scripts live in `verify/` (durable, outside the entry repository).
Summary of the re-verification run in this session:

- Practice: `node verify/check.mjs` — **6/6** vs `expected.json`.
- Edge cases: `node verify/edge.mjs` — **105/105** vs the oracle
  (full list in `verify/REPORT.md`).
- Fuzz: `node verify/fuzz.mjs` — **12,000/12,000** vs the oracle,
  fixed seed 20261121 (mulberry32), 8,000 random + 4,000 structured
  texts; alphabet `, " \r \n a b ' ' x U+FEFF 1 é \t U+1F600 A . -`.
- Held-out: `node verify/heldout.mjs` — **6/6** on a set drawn by the
  kit's own `draw.ts` under a different seed (sha256 of
  `csv-reader-speed-01-heldout-20261121`), 1,524,606–1,943,131 chars
  per case.
- End to end: `node verify/e2e.mjs` — shipped `main.ts`, **6/6**,
  `answers.json` 12,073,155 bytes. Wall 0.76 s, peak RSS 230.2 MiB
  (`verify/e2e-mem.py`; limits wall 10 s, memory 1024 MiB).
- The old "60+ probe inputs" claim from the first build is withdrawn:
  its scripts are lost and the count cannot be reproduced. Its
  substance is replaced by the enumerated 105-case list and the
  CB-04 oracle re-checks in the adjudication file.

### Speed — canonical numbers (solve CPU only)

Method (`verify/bench.mjs`, `taskset -c 0`): 1 untimed warmup round +
9 timed rounds, interleaved per round (entry, baseline, null-entry
control), CPU time via `process.cpuUsage`,
`--no-incremental-marking` before import, trimmed mean dropping the
2 fastest and 2 slowest of the 9. This mirrors the kit's heat
(`competition.yaml`: 9 rounds, 1 warmup, trim 2, "CPU time net of
the null-entry control"). Local machine: Node v24.22.1 (the server
runs Node 22 — not measured locally).

- Trimmed-mean totals: entry **171.6 ms**, baseline **541.5 ms**,
  null control **0.0 ms**.
- **Canonical: the baseline's solve CPU is 3.2x the entry's**
  (541.50 / 171.54 net). This one number is the canonical speed
  figure. It supersedes the first build's Run A (4.76x) and Run B
  (5.22x), whose raw data is lost and whose per-case arithmetic did
  not reproduce from the printed table.
- 95% check: paired difference (baseline − entry) per round, mean
  396.9 ms, sd 191.0 ms; one-sided 95% lower bound (t = 1.860,
  df = 8) = **278.5 ms > 0** — the entry is faster than the baseline
  at 95% confidence on the practice set.
- Per-case trimmed means (diagnostic only — each case's trimmed mean
  drops different rounds, so these rows do not sum to the canonical
  totals; do not divide the sums). Speedups are the displayed means
  divided, rounded to 1 decimal:

| case | chars | baseline ms | entry ms | speedup |
|---|---|---|---|---|
| g-0001 | 1,851,424 | 120.8 | 24.0 | 5.0x |
| g-0002 | 1,837,723 | 94.8 | 36.7 | 2.6x |
| g-0003 | 1,425,003 | 80.7 | 19.8 | 4.1x |
| g-0004 | 1,834,108 | 79.2 | 21.6 | 3.7x |
| g-0005 | 1,777,544 | 78.8 | 16.8 | 4.7x |
| g-0006 | 1,468,151 | 74.0 | 13.2 | 5.6x |

- Path share (counters in the entry's own loop, `verify/dist.mjs`):
  fast path 19.1% of records / 15.0% of chars, slow path 80.9% /
  85.0%. The slow path is the dominant path; the entry's speed comes
  from chunk scanning in the slow path, not from the fast path.
- Distribution bench (4 synthetic ~1.8M-char shapes, oracle-agree on
  all): the entry was faster on every shape in both runs, with ratios
  ranging 1.9–6.7x across shapes and runs — the shared VM is too
  noisy to pin a per-shape ratio, so no single distribution speedup
  is claimed.
- Ablation (`verify/ablation.mjs`): fast path forced off → median
  188.4 ms vs 182.4 ms shipped; junk fast-path forced off → 169.8 ms.
  Both differences are below the rep-to-rep noise floor, so no
  per-optimisation speedup is claimed. The speedup over the baseline
  comes from the whole chunk-scanning design, not from any single
  dispatch.
- Linearity (`verify/linearity.mjs`, CB-05 fix): quoteless input,
  10,000–200,000 rows, 1.45–1.71 µs/row; 20x rows → 19.1x time.

### What was verified, and on which commit

- `solve.js` sha256:
  `3ca0e00ea2664ac0a765647f2211f7a99ff4c826119a4e9f08f7713e89ea4ab3`
  (13,407 bytes). `main.ts` and `package.json` are byte-identical
  copies of the kit baseline's files (sha256
  `884b8b2ffb9c1c309e0bcc455c8c832a5f1fd02ef79a4a008bc61993466a52fd`
  and
  `3ca9d4afd21425087cf31893b8f9f63c81b0b8408db5e343ca76e5f8aa26ab9a`;
  see the kit's `kit.json` file list).
- The final numbers above were measured on that `solve.js` blob.
  The verification commit is recorded in `verify/REPORT.md`
  (filled in when the fix is committed; this file names the blob,
  not the commit, so the two cannot drift apart).
- The entry totals 46,152 bytes of tracked files (this file included)
  against the 1,048,576-byte repository cap (`competition.yaml`
  `max_entry_bytes`).

## Risks and mitigations

- **Local Node v24 vs server Node 22.** **미측정**: no Node 22
  binary is available on this machine, so no Node 22 timing was
  ever run. Mitigation: `solve.js` uses only ES2020-or-earlier
  features and no `node:` imports at all; the driver is the kit's
  own `main.ts`, unchanged. (Note: `kit.json` `harness_version`
  names node v26.13.1 — that is the version the kit harness itself
  was built with, not the entry runtime, which is Node 22 per
  `competition.yaml`.)
- **Server CPU variance (gVisor, 1 CPU, shared host).** Local
  per-round totals swing ~3x for both implementations (entry 89–261
  ms, baseline 283–901 ms); that is why the bench uses trimmed
  means and a paired 95% CI instead of a single timing. The margin
  over the baseline (canonical 3.2x, 95% lower bound on the
  difference 278.5 ms) is the evidence; the server heat decides.
  1-CPU behaviour was measured locally (`taskset -c 0`); gVisor
  itself was not measured.
- **Scored set is a different seed.** Same generator, same
  distributions (`csv-cases.mjs`: 1.4–2.0M chars, 8–18 columns,
  broken-row rates short/long 0.01, stray_cr 0.004, quote_junk
  0.004, blank_line 0.003; one unterminated quote on half the files,
  at most 20 quoteless tail records). Mitigation: held-out set 6/6
  under a different seed, plus the linearity check (no
  input-dependent blowup in the generator's family).
- **Residual unbounded scans.** Two native scans have no end bound
  by construction: the closing-quote search (runs to end of text
  for an unterminated quote — inherent: the quote can only be proven
  unterminated by reaching the end; in the generator's family there
  is at most one per file) and `indexOf(',')` in `unquoted()` (runs
  to the next comma, which can sit past a line break when the field
  ends at LF first; in the generator's family commas sit every
  ~10 characters). Outside the generator's family — a comma-free
  file with stray CRs on many records, or many unterminated quotes —
  either scan can repeat over a long suffix. The probe scan, the
  one that actually fired on quoteless input, is now bounded to the
  line (CB-05 fix).
- **Wall budget 10 s.** Measured end-to-end wall 0.76 s for the
  entry on the practice set (baseline 1.74 s) — 13x headroom on
  local hardware; the server's hardware differs, so this is
  headroom evidence, not a guarantee.
- **A missed oracle behaviour.** Mitigation: 105 edge cases +
  12,000 fuzz cases + held-out 6/6, all matching the oracle. Residual
  risk is an input shape outside both the fuzz alphabet and the
  generator's family; the fuzz alphabet covers every character class
  the parser branches on (`, " \r \n` plus letters, space, tab, BOM,
  digits, non-ASCII, astral emoji).
- **Prize line.** The paid line is the top 10 of 176+ submissions;
  the local numbers say nothing about where this entry ranks among
  them. Only the qualification gate (beat the baseline at 95%) is
  evidenced locally.

## 오답노트 cross-check (~/workspace/makefun/오답노트.md)

Checked against the submission checklist; `[x]` means verified in
this session, `[N/A]` means inapplicable to this bounty with the
reason stated (not verified — do not read `[N/A]` as done):

- [x] 모든 상수·기호에 정의 + 단위 + 출처가 같은 문단에 있는가 —
  yes, see "Constants and symbols" (character codes and terminator
  tags, each with value, meaning, unit and source; no tuned
  constants exist).
- [N/A] 상한·가드가 모든 분기에 적용되는가 — inapplicable: there is
  no clamp, cap or threshold anywhere, so there is no guard that
  could miss a branch.
- [x] 주장(가중치·기대 loss 등)을 식으로 계산해봤는가 — yes: the
  canonical speedup is the measured ratio 541.50/171.54 = 3.2x, and
  the 95% lower bound 278.5 ms is computed from the 9 paired
  round differences in `verify/bench-results.json`.
- [x] 백테스트에 모델 가정과 다른 계열의 시나리오가 있는가 — the
  analogue here is test diversity: fuzz and edge cases include
  shapes the generator never produces (BOM-only, CR-only lines,
  junk with lone CRs, unterminated quotes mid-file, `header` as
  `1`/`null`, non-string `text`), not just generator-family inputs;
  plus a held-out set from a different seed.
- [x] 총량 지표와 모델 함의값이 일치하는가 — the analogue is
  end-to-end agreement: the shipped `main.ts` output matches
  `expected.json` on all 6 cases and matches the baseline's own
  output as a JSON value.
- [x] 최종 horizon에서의 기대 성능을 따로 계산했는가 — the analogue
  is the scored set: same generator/distribution, held-out 6/6,
  linear cost with no input-dependent blowup in the generator's
  family (see Risks for the residual unbounded scans).
- [x] 엣지 케이스 규칙이 문서에 목록으로 있는가 — yes, the table
  above; the full 105-case list is in `verify/REPORT.md`.
- [x] Alternatives·Goals/Non-Goals·Risks(완화책 포함)가 문서에
  있는가 — yes, all four sections are in this file.
- [x] 리뷰 지적을 코드와 대조해 판정했는가 — yes: the egm-review
  findings were adjudicated one by one against the code and the
  oracle in `reviews/adjudication-20261121.md` (15 Blockers, 20
  Majors, 16 Nits; 1 code fix, the rest document fixes, superseded
  numbers, or refutations with evidence — CN-07 refuted by byte
  scan, 0 occurrences).
- [x] 베이스라인이 아니라 상금선(커트라인) 대비로 평가했는가 —
  yes: beating the baseline (3.2x, 95% lower bound 278.5 ms) only
  clears the qualification gate; the paid line is top 10 of 176+
  entries and cannot be measured locally, so no top-10 place is
  claimed (see Goals item 4).
- [x] 클램프·경계·예외 경로를 연습 케이스에 포함했는가 — the
  `['']`-drop, unterminated-tail, junk-with-lone-CR and CR-only-line
  paths are all exercised by the edge suite. Practice-set coverage:
  short/long rows occur by the hundred in every file (generator
  comment in `csv-cases.mjs`); unterminated quotes occur in 2 of
  the 6 practice cases (see the error counts in `verify/REPORT.md`).
- [N/A] 손으로 정한 상수마다 민감도(±20%)를 쟀는가 — inapplicable:
  there are no hand-set constants to vary (see constants section).
- [N/A] 전례 없는 규모·체제 변화에 불확실성 가산이 있는가 —
  inapplicable: no prediction is made by the parser (it is exact,
  not statistical). The scored-set performance *expectation* is
  stated as an expectation with its evidence in Risks, not as a
  measured result.
- [x] 검증 수치가 커밋 해시와 묶여 있고 canonical 수치가 하나인가 —
  yes: `solve.js` sha256 and the verification commit are recorded
  in `verify/REPORT.md`; the canonical speedup figure is one number,
  3.2x (the old 4.76x/5.22x runs are withdrawn there with the reason).
- [x] 실전 점수를 사후에 직접 재현할 데이터·경로가 확보됐는가 —
  the practice set, oracle, edge suite, fuzz and bench scripts are
  all in `verify/` (durable, with hashes); the scored set is drawn
  from drand round 34199652 (a distributed randomness beacon round;
  `instance.yaml`) and cannot be reproduced in advance.
