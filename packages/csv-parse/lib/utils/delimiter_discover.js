import { normalize_options } from "../api/normalize_options.js";
import { transform } from "../api/index.js";

// Discussed in [issue #400](https://github.com/adaltas/node-csv/issues/400)
// See https://github.com/python/cpython/blob/ea1b1c579f600cc85d145c60862b2e6b98701b24/Lib/csv.py#L349

// Number of byte positions inspected by default, shared by `csv-parse` and
// `csv-stringify` so both sides score the same sampling window.
const delimiter_discover_default_size = 2048;
// Character codes excluded from the candidate set: a field delimiter cannot be
// a line break (the record delimiter) or the NUL character (an empty sample).
const delimiter_discover_excluded_codes = [0, 10, 13];
// A candidate is only trustworthy when every sampled record contains it and
// the sample spans at least two records. A character missing from one or more
// records cannot be the column delimiter (a delimiter appears on every row),
// and a single-record sample cannot distinguish a delimiter from content.
const delimiter_discover_min_records = 2;

// Convert a sample (raw buffer/string or an array of records) into an array of
// records, each record being an array of character codes. This is the single
// source of truth shared by the parsing and the stringifying sides.
const delimiter_records = function (records) {
  // Convert String to Buffer
  if (typeof records === "string") {
    records = Buffer.from(records);
  }
  // Convert Buffer to an array of records
  if (Buffer.isBuffer(records)) {
    records = ((data) => {
      const records = [];
      const parser = transform({ delimiter: [] });
      const push = (record) => records.push(record);
      const close = () => {};
      const error = parser.parse(data, true, push, close);
      if (error !== undefined) throw error;
      return records;
    })(records);
  }
  // Normalize each record into an array of character (or byte) codes. Records
  // produced by the parser are buffers, so the counting stays byte-level to
  // preserve the historical discovery behavior.
  return records.map(([record]) => {
    const codes = new Array(record.length);
    for (let i = 0; i < record.length; i++) {
      codes[i] = record.charCodeAt(i);
    }
    return codes;
  });
};

// Structural test shared by both packages: splitting every sampled record on
// a candidate character must produce the same number of fields, and that
// number must be greater than one. Frequency alone cannot distinguish a
// delimiter from a content character present on every record (e.g. the letter
// "a" in `alpha/beta/gamma`, or a "c" present on every row but with a varying
// field count); only a real column delimiter makes every row share the same
// column count. This routine is intentionally strict and identical on both
// sides; the streaming parser handles a truncated sampling window separately
// by discarding its incomplete last record before calling it.
const delimiter_structural_match = function (recordCodes, charCode) {
  let fieldCount;
  for (const codes of recordCodes) {
    // Number of fields is one more than the number of occurrences.
    let count = 1;
    for (const code of codes) if (code === charCode) count++;
    if (count === 1) return false;
    if (fieldCount === undefined) fieldCount = count;
    else if (fieldCount !== count) return false;
  }
  return fieldCount !== undefined && fieldCount >= 2;
};

// Core scoring routine. Consumes an array of records (arrays of char codes) and
// the normalized `delimiter_auto` options. Returns the winning candidate
// information, including a `trusted` flag telling whether the winner is a
// plausible delimiter. Both `csv-parse` and `csv-stringify` call this function
// with identical options, guaranteeing that the same multi-source sample leads
// to the same delimiter decision on both sides.
const delimiter_score = function (
  recordCodes,
  options,
  minRecords = delimiter_discover_min_records,
) {
  // Info array initialization, 127 entries, one per char code. `lines` stays
  // sparse (undefined for records without the character) to preserve the
  // historical standard-deviation computation; `records` explicitly counts
  // the records containing the character, since a sparse array's `length`
  // cannot be used for that purpose.
  const info = Array(127)
    .fill()
    .map(() => ({ lines: [], records: 0 }));
  // Traverse each records, count occurences per char code
  recordCodes.forEach((codes, line) => {
    for (const code of codes) {
      if (info[code].lines[line] === undefined) {
        info[code].lines[line] = 0;
        info[code].records++;
      }
      info[code].lines[line]++;
    }
  });
  // Traverse each char code, compute the score
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
  // Winner selection keeps the historical behavior: the highest-scoring
  // eligible character wins even when its field count is inconsistent across
  // records. This preserves the documented `delimiter_discover` utility.
  const result = info
    .filter(eligible)
    .reduce((acc, info) => (acc.score > info.score ? acc : info), {
      score: 0,
    });
  // Trust is evaluated independently of the winner selection. A trustworthy
  // delimiter must satisfy the structural field-count test and have enough
  // complete records to compare. This is what prevents a frequent content
  // character (e.g. the letter "a" shared by every row) from silently becoming
  // the delimiter.
  result.trusted =
    result.char_code !== undefined &&
    recordCount >= minRecords &&
    delimiter_structural_match(recordCodes, result.char_code);
  return result;
};

const delimiter_discover = function (records, options) {
  // Normalize the configuration
  if (!options) {
    ({ delimiter_auto: options } = normalize_options({ delimiter_auto: true }));
  }
  const result = delimiter_score(delimiter_records(records), options);
  return String.fromCharCode(
    result.char_code === undefined ? 0 : result.char_code,
  );
};

const std = function (array) {
  const n = array.length;
  if (n === 0) return 0;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(
    array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n,
  );
};

export {
  delimiter_discover,
  delimiter_discover_default_size,
  delimiter_discover_min_records,
  delimiter_records,
  delimiter_score,
};
