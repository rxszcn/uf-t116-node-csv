import { get } from "./get.js";

// Automatic field delimiter discovery for `csv-stringify`.
//
// This module is the stringifying-side mirror of
// `csv-parse/lib/utils/delimiter_discover.js`. The two packages do not depend
// on each other, so the sampling window, the candidate scoring formula, the
// preferred characters and the trust criteria are duplicated here on purpose:
// any change must be applied on both sides so the same payload yields the same
// delimiter decision whether it is parsed or stringified.

// Number of characters inspected by default, shared with `csv-parse`. Parsing
// counts bytes on the raw buffer while stringifying counts cast field
// characters; both cap the sampling window at the same 2048 units.
const delimiter_discover_default_size = 2048;
// Character codes excluded from the candidate set: a field delimiter cannot be
// a line break (the record delimiter) or the NUL character (an empty sample).
const delimiter_discover_excluded_codes = [0, 10, 13];
// A candidate is only trustworthy when every sampled record contains it and
// the sample spans at least two records. Must stay identical to the
// parsing-side criterion in
// `csv-parse/lib/utils/delimiter_discover.js`.
const delimiter_discover_min_records = 2;

// Default preferred characters and their boost, identical to the parsing-side
// normalization in `csv-parse/lib/api/normalize_options.js`.
const delimiter_discover_default_preferred = {
  [",".charCodeAt(0)]: 1.8,
  ["\t".charCodeAt(0)]: 1.8,
  [";".charCodeAt(0)]: 1.6,
  [" ".charCodeAt(0)]: 1.6,
  [":".charCodeAt(0)]: 1.5,
  [".".charCodeAt(0)]: 1.4,
  ["/".charCodeAt(0)]: 1.4,
};

const delimiter_discover_default_score = (info, options) => {
  return (info.total - info.std) * (options.preferred[info.char_code] || 1);
};

const std = function (array) {
  const n = array.length;
  if (n === 0) return 0;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(
    array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n,
  );
};

// Convert buffered input records into an array of records, each record being
// an array of character codes. Fields are cast the same way they are when
// emitted, so the scored sample reflects the actual serialized output. The
// returned object carries the first casting error, if any.
const delimiter_records = function (records, columns, cast) {
  const recordCodes = [];
  for (let recordsIndex = 0; recordsIndex < records.length; recordsIndex++) {
    const chunk = records[recordsIndex];
    const fields = [];
    if (Array.isArray(chunk)) {
      for (let i = 0; i < chunk.length; i++) fields.push(chunk[i]);
    } else {
      for (const column of columns) fields.push(get(chunk, column.key));
    }
    const codes = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const [err, value] = cast(field, {
        index: i,
        column: Array.isArray(chunk) ? i : columns[i].key,
        records: recordsIndex,
        header: false,
      });
      if (err !== undefined) return { err };
      if (value === null || value === undefined) continue;
      const str = String(value);
      for (let j = 0; j < str.length; j++) {
        codes.push(str.charCodeAt(j));
      }
    }
    recordCodes.push(codes);
  }
  return { recordCodes };
};

// Structural test, identical to the parsing-side one in
// `csv-parse/lib/utils/delimiter_discover.js`: splitting every sampled record
// on a candidate must yield the same number of fields and more than one.
// Stringified records are always complete, so there is no truncation to
// tolerate here.
const delimiter_structural_match = function (recordCodes, charCode) {
  let fieldCount;
  for (const codes of recordCodes) {
    let count = 1;
    for (const code of codes) if (code === charCode) count++;
    if (count === 1) return false;
    if (fieldCount === undefined) fieldCount = count;
    else if (fieldCount !== count) return false;
  }
  return fieldCount !== undefined && fieldCount >= 2;
};

// Core scoring routine, byte-for-byte equivalent in intent to the parsing-side
// `delimiter_score`: same 127 character-code slots, same frequency / standard
// deviation computation and same trust criterion.
const delimiter_score = function (
  recordCodes,
  options,
  minRecords = delimiter_discover_min_records,
) {
  const info = Array(127)
    .fill()
    .map(() => ({ lines: [], records: 0 }));
  recordCodes.forEach((codes, line) => {
    for (const code of codes) {
      if (info[code].lines[line] === undefined) {
        info[code].lines[line] = 0;
        info[code].records++;
      }
      info[code].lines[line]++;
    }
  });
  info.forEach((info, i) => {
    info.char_code = i;
    info.std = std(info.lines);
    info.total = info.lines.reduce((acc, val) => acc + val, 0);
    info.preferred = !!options.preferred[i];
    info.score = options.score(info, options);
  });
  const recordCount = recordCodes.length;
  const eligible = (info) =>
    !delimiter_discover_excluded_codes.includes(info.char_code) &&
    info.total > 0;
  // Winner selection mirrors the parsing side: the highest-scoring eligible
  // character wins. Trust is then evaluated independently.
  const result = info
    .filter(eligible)
    .reduce((acc, info) => (acc.score > info.score ? acc : info), {
      score: 0,
    });
  result.trusted =
    result.char_code !== undefined &&
    recordCount >= minRecords &&
    delimiter_structural_match(recordCodes, result.char_code);
  return result;
};

export {
  delimiter_discover_default_preferred,
  delimiter_discover_default_score,
  delimiter_discover_default_size,
  delimiter_discover_min_records,
  delimiter_records,
  delimiter_score,
};
