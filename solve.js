// csv-reader-speed: a fast drop-in for csv-reader 1.0.0.
//
// Written from the competition's parsing specification (RULES.txt / the
// competition description), not from the vendor source. For every input
// {text, header} it returns {columns, rows, errors} exactly as csv-reader
// 1.0.0 does, but scanned in chunks instead of one character at a time.
//
// How it works
// -----------
// A single cursor advances left to right over the text, but some
// spans are re-scanned: the line breaks inside a quoted field are
// counted in a second pass over that field, CRs inside quotes are
// normalised in a third pass when present, and a quote that never
// closes makes its field re-read as unquoted. Records are handled
// by two paths:
//
// * Fast path: a record whose line holds no double quote and no carriage
//   return (other than a CRLF at its end) is sliced out and split(',') in
//   one native call. This covers plain numeric / word / code / date rows.
// * Slow path: any record holding a quote or a CR is parsed field by
//   field. An unquoted field is found with one indexOf(',') plus the
//   short scan to that comma, which also finds the first LF or CR in
//   the segment (a CR is dropped with a stray_cr error and the field
//   continues). A quoted field is found with
//   indexOf('"'), doubled quotes ("") collapse to one, CR/LF/CRLF inside
//   quotes each become one LF, and the junk after the closing quote is read
//   with the same unquoted scanner (a lone CR there is dropped with
//   stray_cr, and quote_junk fires only when the junk holds >= 1 kept
//   character). A quote that never closes (no un-doubled quote anywhere
//   after it) is a literal character: the field is re-read as unquoted
//   from the opening quote, after an unterminated_quote error.
//
// Line numbers: LF and CRLF outside quotes end a record and count one
// line; a stray CR outside quotes counts no line; every LF, CRLF and lone
// CR inside quotes counts one line; blank lines are skipped and count one
// line. An error's line is the line its record starts on, and its row is
// the record's index in rows (null for the header record, which is the
// first real record when header is true).
//
// A record that parses to exactly [''] with no quoted field in it is not
// a record (it is a line of nothing but dropped CRs); its errors stay.
// Otherwise the first real record sets the width; later records are
// padded with '' (short_row, with fields: its field count) or cut
// (long_row, with extra: the cut fields). The header record is never
// padded or cut. With header true and no records at all, columns is [].
//
// No dependencies, no cache between cases, no clock, no randomness, no
// regular expressions, no whole-text split. ES2020-or-earlier features
// only in this file (no Node-version-specific syntax), so it runs on
// Node 22 as well as here. (The driver main.ts is the kit's TypeScript;
// that claim covers solve.js only.)

const CHAR_QUOTE = 34; // "
const CHAR_COMMA = 44; // ,
const CHAR_LF = 10; // \n
const CHAR_CR = 13; // \r
const CHAR_BOM = 0xfeff; // U+FEFF

// Terminator kinds shared by the field scanners below.
const TERM_COMMA = 0;
const TERM_EOL = 1;
const TERM_EOF = 2;

export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;

  const rows = [];
  const errors = [];
  let columns = null;
  let width = 0;
  let haveFirst = false;
  let line = 1;
  let i = 0;
  if (s.charCodeAt(0) === CHAR_BOM) i = 1;

  // Record currently being parsed: its start line and its row index
  // (null while it is the header record). Read by the scanners.
  let recLine = 1;
  let recRow = null;

  // Scratch outputs of unquoted(), to avoid an allocation per field.
  let ufValue = '';
  let ufTerm = TERM_EOF;
  let ufNext = 0;

  // Replace each CRLF or lone CR in str with one LF. Only called when
  // str is known to hold a CR.
  function normalizeCR(str) {
    const out = [];
    let start = 0;
    let pos = 0;
    for (;;) {
      const r = str.indexOf('\r', pos);
      if (r === -1) break;
      out.push(str.slice(start, r), '\n');
      pos = r + 1;
      if (str.charCodeAt(pos) === CHAR_LF) pos++;
      start = pos;
    }
    out.push(str.slice(start));
    return out.join('');
  }

  // Read one unquoted field starting at `from` (its first character is
  // not a quote). Sets ufValue / ufTerm / ufNext. One indexOf(',') per
  // field; the native scan stops at the next comma, which in the usual
  // case sits inside this record — but it can run past a line break
  // when the field ends at LF before any comma follows (the field
  // still ends at the LF, and the comma found is ignored for this
  // field). The character-by-character scan below never goes past
  // the field's end: it stops at the first LF or CR, or at that
  // comma. A CR not followed by LF is dropped
  // with a stray_cr error and the field continues past it; a CR
  // followed by LF, or an LF, ends the record (line advances by one);
  // a comma ends the field; end of text ends the record.
  function unquoted(from) {
    let pos = from;
    let segStart = from;
    let parts = null;
    let ci = s.indexOf(',', pos);
    for (;;) {
      const scanEnd = ci === -1 ? n : ci;
      let special = -1;
      let isLF = false;
      for (let p = pos; p < scanEnd; p++) {
        const cc = s.charCodeAt(p);
        if (cc === CHAR_LF) {
          special = p;
          isLF = true;
          break;
        }
        if (cc === CHAR_CR) {
          special = p;
          break;
        }
      }
      if (special === -1) {
        ufValue =
          parts === null
            ? s.slice(segStart, scanEnd)
            : parts.join('') + s.slice(segStart, scanEnd);
        if (ci === -1) {
          ufTerm = TERM_EOF;
          ufNext = n;
        } else {
          ufTerm = TERM_COMMA;
          ufNext = ci + 1;
        }
        return;
      }
      if (isLF) {
        ufValue =
          parts === null
            ? s.slice(segStart, special)
            : parts.join('') + s.slice(segStart, special);
        ufTerm = TERM_EOL;
        ufNext = special + 1;
        line++;
        return;
      }
      if (s.charCodeAt(special + 1) === CHAR_LF) {
        // CRLF: the field ends before the CR, the record ends.
        ufValue =
          parts === null
            ? s.slice(segStart, special)
            : parts.join('') + s.slice(segStart, special);
        ufTerm = TERM_EOL;
        ufNext = special + 2;
        line++;
        return;
      }
      // Lone CR: drop it, report it, keep the field going. The next
      // comma is still ci (no comma sits before it), so ci is reused.
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      if (parts === null) parts = [];
      if (special > segStart) parts.push(s.slice(segStart, special));
      pos = special + 1;
      segStart = special + 1;
    }
  }

  // Finish one parsed record: drop it when it is exactly [''] with no
  // quoted field, else set the width / header, or pad / cut it to the
  // width and record short_row / long_row.
  function finish(fields, anyQuoted) {
    if (fields.length === 1 && fields[0] === '' && !anyQuoted) return;
    if (!haveFirst) {
      haveFirst = true;
      width = fields.length;
      if (header) {
        columns = fields;
        return;
      }
      rows.push(fields);
      return;
    }
    if (fields.length === width) {
      rows.push(fields);
      return;
    }
    if (fields.length < width) {
      errors.push({
        code: 'short_row',
        line: recLine,
        row: recRow,
        fields: fields.length,
      });
      for (let k = fields.length; k < width; k++) fields.push('');
      rows.push(fields);
      return;
    }
    errors.push({
      code: 'long_row',
      line: recLine,
      row: recRow,
      extra: fields.slice(width),
    });
    fields.length = width;
    rows.push(fields);
  }

  while (i < n) {
    // Skip blank lines before a record: a lone LF, or a CRLF. A line
    // holding only a lone CR is not skipped; it parses as a record.
    const c0 = s.charCodeAt(i);
    if (c0 === CHAR_LF) {
      i++;
      line++;
      continue;
    }
    if (c0 === CHAR_CR && s.charCodeAt(i + 1) === CHAR_LF) {
      i += 2;
      line++;
      continue;
    }

    recLine = line;
    recRow = header && !haveFirst ? null : rows.length;

    // Probe the record's first line. A record with no quote and no CR
    // on that line (a CRLF at its end does not count) takes the fast
    // path; anything else takes the field-by-field path. Note the
    // line end here is only a probe: a quoted field may run past it.
    const nl = s.indexOf('\n', i);
    const lineEnd = nl === -1 ? n : nl;
    let contentEnd = lineEnd;
    if (nl !== -1 && lineEnd > i && s.charCodeAt(lineEnd - 1) === CHAR_CR) {
      contentEnd = lineEnd - 1;
    }
    // Probe the record's first line, bounded to that line: slice the
    // line out once and test the slice for a quote or a CR. An
    // unbounded indexOf('"', i) would scan to the end of the text
    // whenever the file holds no later quote, which made quoteless
    // input superlinear — one end-of-text scan per record. The slice
    // itself is O(line length). A quoted field may run past this
    // line; that only sends the record to the slow path, which
    // re-scans from the field start.
    const probe = s.slice(i, contentEnd);
    const fastOK = probe.indexOf('"') === -1 && probe.indexOf('\r') === -1;
    if (fastOK) {
      const fields = probe.split(',');
      i = nl === -1 ? n : nl + 1;
      line++;
      finish(fields, false);
      continue;
    }

    // Slow path: parse the record field by field.
    const fields = [];
    let anyQuoted = false;
    let term = TERM_EOF;
    for (;;) {
      let field;
      if (s.charCodeAt(i) === CHAR_QUOTE) {
        anyQuoted = true;
        // Quoted field: find the closing quote, skipping "" pairs.
        let pos = i + 1;
        let segStart = i + 1;
        let parts = null;
        let close = -1;
        for (;;) {
          const qq = s.indexOf('"', pos);
          if (qq === -1) break;
          if (s.charCodeAt(qq + 1) === CHAR_QUOTE) {
            if (parts === null) parts = [];
            parts.push(s.slice(segStart, qq + 1));
            pos = qq + 2;
            segStart = qq + 2;
          } else {
            close = qq;
            break;
          }
        }
        if (close === -1) {
          // No closing quote anywhere after this one: the quote is a
          // literal character, and the field is re-read as unquoted
          // from the opening quote.
          errors.push({
            code: 'unterminated_quote',
            line: recLine,
            row: recRow,
          });
          unquoted(i);
          field = ufValue;
          term = ufTerm;
          i = ufNext;
        } else {
          let content =
            parts === null
              ? s.slice(segStart, close)
              : parts.join('') + s.slice(segStart, close);
          // Line breaks inside the quotes: count them over the span
          // between the opening and closing quotes, and normalise
          // CRs to LF.
          let breaks = 0;
          let hasCR = false;
          for (let p = i + 1; p < close; p++) {
            const cc = s.charCodeAt(p);
            if (cc === CHAR_LF) {
              breaks++;
            } else if (cc === CHAR_CR) {
              breaks++;
              hasCR = true;
              if (s.charCodeAt(p + 1) === CHAR_LF) p++;
            }
          }
          line += breaks;
          if (hasCR) content = normalizeCR(content);
          // Junk after the closing quote. Usually there is none: the
          // next character is a comma, a line break, or the end of
          // the text, and the field ends there with no extra scan.
          // Anything else (junk characters, or a lone CR) goes
          // through the unquoted scanner, which drops a lone CR with
          // stray_cr and runs the junk to the next comma or break.
          const j0 = close + 1;
          if (j0 >= n) {
            field = content;
            term = TERM_EOF;
            i = n;
          } else {
            const jc = s.charCodeAt(j0);
            if (jc === CHAR_COMMA) {
              field = content;
              term = TERM_COMMA;
              i = j0 + 1;
            } else if (jc === CHAR_LF) {
              field = content;
              term = TERM_EOL;
              i = j0 + 1;
              line++;
            } else if (jc === CHAR_CR && s.charCodeAt(j0 + 1) === CHAR_LF) {
              field = content;
              term = TERM_EOL;
              i = j0 + 2;
              line++;
            } else {
              unquoted(j0);
              field = content + ufValue;
              if (ufValue.length > 0) {
                errors.push({ code: 'quote_junk', line: recLine, row: recRow });
              }
              term = ufTerm;
              i = ufNext;
            }
          }
        }
      } else {
        unquoted(i);
        field = ufValue;
        term = ufTerm;
        i = ufNext;
      }
      fields.push(field);
      if (term === TERM_COMMA) continue;
      break;
    }
    finish(fields, anyQuoted);
  }

  if (header && !haveFirst) columns = [];
  return { columns, rows, errors };
}
