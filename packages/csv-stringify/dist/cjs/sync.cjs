'use strict';

// Lodash implementation of `get`

const charCodeOfDot = ".".charCodeAt(0);
const reEscapeChar = /\\(\\)?/g;
const rePropName = RegExp(
  // Match anything that isn't a dot or bracket.
  "[^.[\\]]+" +
    "|" +
    // Or match property names within brackets.
    "\\[(?:" +
    // Match a non-string expression.
    "([^\"'][^[]*)" +
    "|" +
    // Or match strings (supports escaping characters).
    "([\"'])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2" +
    ")\\]" +
    "|" +
    // Or match "" as the space between consecutive dots or empty brackets.
    "(?=(?:\\.|\\[\\])(?:\\.|\\[\\]|$))",
  "g",
);
const reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/;
const reIsPlainProp = /^\w*$/;

const getTag = function (value) {
  // if (!value) value === undefined ? "[object Undefined]" : "[object Null]";
  return Object.prototype.toString.call(value);
};

const isSymbol = function (value) {
  const type = typeof value;
  return (
    type === "symbol" ||
    (type === "object" && value && getTag(value) === "[object Symbol]")
  );
};

const isKey = function (value, object) {
  if (Array.isArray(value)) {
    return false;
  }
  const type = typeof value;
  if (
    type === "number" ||
    type === "symbol" ||
    type === "boolean" ||
    !value ||
    isSymbol(value)
  ) {
    return true;
  }
  return (
    reIsPlainProp.test(value) ||
    !reIsDeepProp.test(value) ||
    (object != null && value in Object(object))
  );
};

const stringToPath = function (string) {
  const result = [];
  if (string.charCodeAt(0) === charCodeOfDot) {
    result.push("");
  }
  string.replace(rePropName, function (match, expression, quote, subString) {
    let key = match;
    if (quote) {
      key = subString.replace(reEscapeChar, "$1");
    } else if (expression) {
      key = expression.trim();
    }
    result.push(key);
  });
  return result;
};

const castPath = function (value, object) {
  if (Array.isArray(value)) {
    return value;
  } else {
    return isKey(value, object) ? [value] : stringToPath(value);
  }
};

const toKey = function (value) {
  if (typeof value === "string" || isSymbol(value)) return value;
  const result = `${value}`;
  return result == "0" && 1 / value == -Infinity ? "-0" : result;
};

const get = function (object, path) {
  path = castPath(path, object);
  let index = 0;
  const length = path.length;
  while (object != null && index < length) {
    object = object[toKey(path[index++])];
  }
  return index && index === length ? object : undefined;
};

const is_object = function (obj) {
  return typeof obj === "object" && obj !== null && !Array.isArray(obj);
};

class CsvError extends Error {
  constructor(code, message, ...contexts) {
    if (Array.isArray(message)) message = message.join(" ");
    super(message);
    if (Error.captureStackTrace !== undefined) {
      Error.captureStackTrace(this, CsvError);
    }
    this.code = code;
    for (const context of contexts) {
      for (const key in context) {
        const value = context[key];
        this[key] = Buffer.isBuffer(value)
          ? value.toString()
          : value == null
            ? value
            : JSON.parse(JSON.stringify(value));
      }
    }
  }
}

const normalize_columns = function (columns) {
  if (columns === undefined || columns === null) {
    return [undefined, undefined];
  }
  if (typeof columns !== "object") {
    return [Error('Invalid option "columns": expect an array or an object')];
  }
  if (!Array.isArray(columns)) {
    const newcolumns = [];
    for (const k in columns) {
      newcolumns.push({
        key: k,
        header: columns[k],
      });
    }
    columns = newcolumns;
  } else {
    const newcolumns = [];
    for (const column of columns) {
      if (typeof column === "string") {
        newcolumns.push({
          key: column,
          header: column,
        });
      } else if (
        typeof column === "object" &&
        column !== null &&
        !Array.isArray(column)
      ) {
        if (!column.key) {
          return [
            Error('Invalid column definition: property "key" is required'),
          ];
        }
        if (column.header === undefined) {
          column.header = column.key;
        }
        newcolumns.push(column);
      } else {
        return [
          Error("Invalid column definition: expect a string or an object"),
        ];
      }
    }
    columns = newcolumns;
  }
  return [undefined, columns];
};

const underscore = function (str) {
  return str.replace(/([A-Z])/g, function (_, match) {
    return "_" + match.toLowerCase();
  });
};

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
  return (
    (info.total - info.std) * (options.preferred[info.char_code] || 1)
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

const normalize_options = function (opts) {
  const options = {};
  // Merge with user options
  for (const opt in opts) {
    options[underscore(opt)] = opts[opt];
  }
  // Normalize option `bom`
  if (
    options.bom === undefined ||
    options.bom === null ||
    options.bom === false
  ) {
    options.bom = false;
  } else if (options.bom !== true) {
    return [
      new CsvError("CSV_OPTION_BOOLEAN_INVALID_TYPE", [
        "option `bom` is optional and must be a boolean value,",
        `got ${JSON.stringify(options.bom)}`,
      ]),
    ];
  }
  // Normalize option `delimiter`
  // The literal "auto" (string or buffer) requests automatic discovery from
  // the incoming records. Without this conversion it would be emitted as a
  // literal four-character separator, fusing every column into one string.
  const delimiter_auto_requested =
    options.delimiter === "auto" ||
    (Buffer.isBuffer(options.delimiter) &&
      options.delimiter.toString() === "auto");
  if (options.delimiter === undefined || options.delimiter === null) {
    options.delimiter = ",";
  } else if (delimiter_auto_requested) {
    // Comma is only a placeholder until discovery runs on the first records.
    options.delimiter = ",";
  } else if (Buffer.isBuffer(options.delimiter)) {
    options.delimiter = options.delimiter.toString();
  } else if (typeof options.delimiter !== "string") {
    return [
      new CsvError("CSV_OPTION_DELIMITER_INVALID_TYPE", [
        "option `delimiter` must be a buffer or a string,",
        `got ${JSON.stringify(options.delimiter)}`,
      ]),
    ];
  }
  // Automatic discovery configuration is internal to the stringifier. It is
  // stored as a non-enumerable property so the public `options` shape (and its
  // enumerated keys) stays identical to the explicit-delimiter behavior.
  if (delimiter_auto_requested) {
    Object.defineProperty(options, "delimiter_auto", {
      value: {
        preferred: delimiter_discover_default_preferred,
        score: delimiter_discover_default_score,
        size: delimiter_discover_default_size,
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  // Normalize option `quote`
  if (options.quote === undefined || options.quote === null) {
    options.quote = '"';
  } else if (options.quote === true) {
    options.quote = '"';
  } else if (options.quote === false) {
    options.quote = "";
  } else if (Buffer.isBuffer(options.quote)) {
    options.quote = options.quote.toString();
  } else if (typeof options.quote !== "string") {
    return [
      new CsvError("CSV_OPTION_QUOTE_INVALID_TYPE", [
        "option `quote` must be a boolean, a buffer or a string,",
        `got ${JSON.stringify(options.quote)}`,
      ]),
    ];
  }
  // Normalize option `relax_quotes`
  if (options.relax_quotes === undefined || options.relax_quotes === null) {
    options.relax_quotes = false;
  } else if (typeof options.relax_quotes !== "boolean") {
    return [
      new CsvError("CSV_OPTION_RELAX_QUOTES_INVALID_TYPE", [
        "option `relax_quotes` must be a boolean,",
        `got ${JSON.stringify(options.relax_quotes)}`,
      ]),
    ];
  }
  // Normalize option `quoted`
  if (options.quoted === undefined || options.quoted === null) {
    options.quoted = false;
  }
  // Normalize option `escape_formulas`
  if (
    options.escape_formulas === undefined ||
    options.escape_formulas === null
  ) {
    options.escape_formulas = false;
  } else if (typeof options.escape_formulas !== "boolean") {
    return [
      new CsvError("CSV_OPTION_ESCAPE_FORMULAS_INVALID_TYPE", [
        "option `escape_formulas` must be a boolean,",
        `got ${JSON.stringify(options.escape_formulas)}`,
      ]),
    ];
  }
  // Normalize option `quoted_empty`
  if (options.quoted_empty === undefined || options.quoted_empty === null) {
    options.quoted_empty = undefined;
  }
  // Normalize option `quoted_match`
  if (
    options.quoted_match === undefined ||
    options.quoted_match === null ||
    options.quoted_match === false
  ) {
    options.quoted_match = null;
  } else if (!Array.isArray(options.quoted_match)) {
    options.quoted_match = [options.quoted_match];
  }
  if (options.quoted_match) {
    for (const quoted_match of options.quoted_match) {
      const isString = typeof quoted_match === "string";
      const isRegExp = quoted_match instanceof RegExp;
      if (!isString && !isRegExp) {
        return [
          new CsvError("CSV_OPTION_QUOTED_MATCH", [
            "option `quoted_match` must be a string or a regex,",
            `got ${JSON.stringify(options.quoted_match)}`,
          ]),
        ];
      }
    }
  }
  // Normalize option `quoted_string`
  if (options.quoted_string === undefined || options.quoted_string === null) {
    options.quoted_string = false;
  }
  // Normalize option `eof`
  if (options.eof === undefined || options.eof === null) {
    options.eof = true;
  }
  // Normalize option `escape`
  if (options.escape === undefined || options.escape === null) {
    options.escape = '"';
  } else if (Buffer.isBuffer(options.escape)) {
    options.escape = options.escape.toString();
  } else if (typeof options.escape !== "string") {
    return [
      Error(
        `Invalid Option: escape must be a buffer or a string, got ${JSON.stringify(options.escape)}`,
      ),
    ];
  }
  if (options.escape.length > 1) {
    return [
      Error(
        `Invalid Option: escape must be one character, got ${options.escape.length} characters`,
      ),
    ];
  }
  // Normalize option `header`
  if (
    options.header === undefined ||
    options.header === null ||
    options.header === false
  ) {
    options.header = false;
  } else if (options.header !== true) {
    throw new CsvError(
      "CSV_INVALID_OPTION_HEADER",
      [
        "option `header` is expected to be a boolean,",
        `got ${JSON.stringify(options.header)}`,
      ],
      options,
    );
  }
  // Normalize option `headers_as_comment`
  if (
    options.header_as_comment === undefined ||
    options.header_as_comment === null ||
    options.header_as_comment === false
  ) {
    options.header_as_comment = false;
  } else if (options.header_as_comment === true) {
    options.header_as_comment = "#";
  } else if (Buffer.isBuffer(options.header_as_comment)) {
    options.header_as_comment = options.header_as_comment.toString();
  } else if (typeof options.header_as_comment !== "string") {
    throw new CsvError(
      "CSV_INVALID_OPTION_HEADER_AS_COMMENT",
      [
        "option `header_as_comment` must be a boolean, a string or a buffer,",
        `got ${JSON.stringify(options.header_as_comment)}`,
      ],
      options,
    );
  }
  // if (options.header_as_comment && !options.comment?.length) {
  //   throw new CsvError(
  //     "CSV_INVALID_OPTION_COMMENT",
  //     [
  //       "option `comment` must be a non empty string or buffer when using `header_as_comment`,",
  //       `got ${JSON.stringify(options.comment)}`,
  //     ],
  //     options,
  //   );
  // }
  // Header is always enabled with `header_as_comment`
  // if (options.header_as_comment === true) {
  //   options.header = true;
  // }
  // Normalize option `columns`
  const [errColumns, columns] = normalize_columns(options.columns);
  if (errColumns !== undefined) return [errColumns];
  options.columns = columns;
  // Normalize option `quoted`
  if (options.quoted === undefined || options.quoted === null) {
    options.quoted = false;
  }
  // Normalize option `cast`
  if (options.cast === undefined || options.cast === null) {
    options.cast = {};
  } else {
    options.cast = { ...options.cast };
  }
  // Normalize option cast.bigint
  if (options.cast.bigint === undefined || options.cast.bigint === null) {
    // Cast boolean to string by default
    options.cast.bigint = (value) => "" + value;
  }
  // Normalize option cast.boolean
  if (options.cast.boolean === undefined || options.cast.boolean === null) {
    // Cast boolean to string by default
    options.cast.boolean = (value) => (value ? "1" : "");
  }
  // Normalize option cast.date
  if (options.cast.date === undefined || options.cast.date === null) {
    // Cast date to timestamp string by default
    options.cast.date = (value) => "" + value.getTime();
  }
  // Normalize option cast.number
  if (options.cast.number === undefined || options.cast.number === null) {
    // Cast number to string using native casting by default
    options.cast.number = (value) => "" + value;
  }
  // Normalize option cast.object
  if (options.cast.object === undefined || options.cast.object === null) {
    // Stringify object as JSON by default
    options.cast.object = (value) => JSON.stringify(value);
  }
  // Normalize option cast.string
  if (options.cast.string === undefined || options.cast.string === null) {
    // Leave string untouched
    options.cast.string = function (value) {
      return value;
    };
  }
  // Normalize option `on_record`
  if (
    options.on_record !== undefined &&
    typeof options.on_record !== "function"
  ) {
    return [Error(`Invalid Option: "on_record" must be a function.`)];
  }
  // Normalize option `quote_record_delimiter`
  if (
    options.quote_record_delimiter === undefined ||
    options.quote_record_delimiter === null
  ) {
    options.quote_record_delimiter = !options.record_delimiter;
  } else if (typeof options.quote_record_delimiter !== "boolean") {
    return [
      new CsvError("CSV_OPTION_QUOTE_RECORD_DELIMITER_INVALID_TYPE", [
        "option `quote_record_delimiter` must be a boolean,",
        `got ${JSON.stringify(options.quote_record_delimiter)}`,
      ]),
    ];
  }
  // Normalize option `record_delimiter`
  if (
    options.record_delimiter === undefined ||
    options.record_delimiter === null
  ) {
    options.record_delimiter = "\n";
  } else if (Buffer.isBuffer(options.record_delimiter)) {
    options.record_delimiter = options.record_delimiter.toString();
  } else if (typeof options.record_delimiter !== "string") {
    return [
      Error(
        `Invalid Option: record_delimiter must be a buffer or a string, got ${JSON.stringify(options.record_delimiter)}`,
      ),
    ];
  }
  switch (options.record_delimiter) {
    case "unix":
      options.record_delimiter = "\n";
      break;
    case "mac":
      options.record_delimiter = "\r";
      break;
    case "windows":
      options.record_delimiter = "\r\n";
      break;
    case "ascii":
      options.record_delimiter = "\u001e";
      break;
    case "unicode":
      options.record_delimiter = "\u2028";
      break;
  }
  return [undefined, options];
};

const bom_utf8 = Buffer.from([239, 187, 191]);
// True when appending `separator` after `value` would let `parse` find
// `separator` starting inside `value`. Besides the field containing the whole
// separator, this also covers boundary fusion: a field whose tail is a
// non-empty prefix of a multi-character separator merges with the appended
// separator (eg value "a:" + delimiter "::" => "a:::", matched at offset 1).
// Such fields must be quoted to round-trip, like RFC 4180 fields containing the
// delimiter, generalized to multi-character delimiters and record delimiters.
const emits_separator = function (value, separators) {
  return separators.some(
    (separator) =>
      separator.length !== 0 &&
      (value.indexOf(separator) !== -1 ||
        (separator.length > 1 &&
          (value + separator).indexOf(separator) < value.length)),
  );
};
// True when `value` matches one of the `quoted_match` patterns. The regexps
// come from the user and the same objects are reused for every field, so the
// test must not depend on their state: `RegExp.prototype.test` advances
// `lastIndex` on a global or sticky regexp, which would make a match in one
// field move where the next field starts matching. `String.prototype.search`
// searches from the start and restores `lastIndex`, and is equivalent to
// `test` for the stateless regexps.
const matches_quoted_match = function (value, quoted_match) {
  if (!quoted_match) return false;
  return quoted_match.some((pattern) =>
    typeof pattern === "string"
      ? value.indexOf(pattern) !== -1
      : value.search(pattern) !== -1,
  );
};

const stringifier = function (options, state, info) {
  return {
    options: options,
    state: state,
    info: info,
    // Record buffering used while the field delimiter is discovered. `buffer`
    // holds the input records and `buffer_size` tracks their cast character
    // count to apply the same sampling window as the parsing side.
    state_auto: {
      buffer: [],
      size: 0,
    },
    // Run automatic delimiter discovery over the buffered records and, on
    // success, emit every buffered record again through the regular path.
    __delimiter_auto_finalize: function (push) {
      const { err, recordCodes } = delimiter_records(
        this.state_auto.buffer,
        this.options.columns,
        (value, context) => this.__cast(value, context),
      );
      if (err !== undefined) return err;
      const result = delimiter_score(recordCodes, this.options.delimiter_auto);
      if (!result.trusted) {
        return new CsvError("CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE", [
          "Invalid option `delimiter`:",
          "no field delimiter could be discovered from the sampled records,",
          `sampled ${this.state_auto.size} characters over a maximum window of ${this.options.delimiter_auto.size} characters,`,
          "set the `delimiter` option explicitly to stringify this data",
        ]);
      }
      this.options.delimiter = String.fromCharCode(result.char_code);
      const buffered = this.state_auto.buffer;
      this.state_auto.buffer = [];
      this.state_auto.size = 0;
      this.state.pending_delimiter_auto = false;
      for (const record of buffered) {
        const err = this.__transform(record, push);
        if (err !== undefined) return err;
      }
      return undefined;
    },
    // Cast one record and return the total length of its serialized fields.
    // Used only to bound the discovery sampling window.
    __delimiter_auto_record_size: function (chunk) {
      const fields = [];
      if (Array.isArray(chunk)) {
        for (const field of chunk) fields.push(field);
      } else {
        for (const column of this.options.columns)
          fields.push(get(chunk, column.key));
      }
      let size = 0;
      for (let i = 0; i < fields.length; i++) {
        const [err, value] = this.__cast(fields[i], {
          index: i,
          column: Array.isArray(chunk) ? i : this.options.columns[i].key,
          records: this.info.records,
          header: false,
        });
        if (err !== undefined) return undefined;
        if (value !== null && value !== undefined) size += String(value).length;
      }
      return size;
    },
    __transform: function (chunk, push) {
      // Chunk validation
      if (!Array.isArray(chunk) && typeof chunk !== "object") {
        return Error(
          `Invalid Record: expect an array or an object, got ${JSON.stringify(chunk)}`,
        );
      }
      // Detect columns from the first record
      if (this.info.records === 0) {
        if (Array.isArray(chunk)) {
          if (
            this.options.header === true &&
            this.options.columns === undefined
          ) {
            return Error(
              "Undiscoverable Columns: header option requires column option or object records",
            );
          }
        } else if (this.options.columns === undefined) {
          const [err, columns] = normalize_columns(Object.keys(chunk));
          if (err) return;
          this.options.columns = columns;
        }
      }
      // Automatic delimiter discovery: keep buffering records until the
      // sampling window is filled. The window and the scoring are identical to
      // `csv-parse`, so both sides converge on the same delimiter.
      if (this.state.pending_delimiter_auto === true) {
        const size = this.__delimiter_auto_record_size(chunk);
        if (size === undefined) {
          return new CsvError("CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE", [
            "Invalid option `delimiter`:",
            "a field could not be cast while sampling records for delimiter discovery,",
            "set the `delimiter` option explicitly to stringify this data",
          ]);
        }
        this.state_auto.buffer.push(chunk);
        this.state_auto.size += size;
        if (this.state_auto.size < this.options.delimiter_auto.size) {
          return;
        }
        const err = this.__delimiter_auto_finalize(push);
        if (err !== undefined) return err;
        return;
      }
      // Emit the header
      if (this.info.records === 0) {
        this.bom(push);
        const err = this.headers(push);
        if (err) return err;
      }
      // Emit and stringify the record if an object or an array
      try {
        // this.emit('record', chunk, this.info.records);
        if (this.options.on_record) {
          this.options.on_record(chunk, this.info.records);
        }
      } catch (err) {
        return err;
      }
      // Convert the record into a string
      let err, chunk_string;
      if (this.options.eof) {
        [err, chunk_string] = this.stringify(chunk);
        if (err) return err;
        if (chunk_string === undefined) {
          return;
        } else {
          chunk_string = chunk_string + this.options.record_delimiter;
        }
      } else {
        [err, chunk_string] = this.stringify(chunk);
        if (err) return err;
        if (chunk_string === undefined) {
          return;
        } else {
          if (this.options.header || this.info.records) {
            chunk_string = this.options.record_delimiter + chunk_string;
          }
        }
      }
      // Emit the csv
      this.info.records++;
      push(chunk_string);
    },
    stringify: function (chunk, chunkIsHeader = false) {
      if (typeof chunk !== "object") {
        return [undefined, chunk];
      }
      const { columns } = this.options;
      const record = [];
      // Record is an array
      if (Array.isArray(chunk)) {
        // We are getting an array but the user has specified output columns. In
        // this case, we respect the columns indexes
        const length = columns
          ? Math.min(chunk.length, columns.length)
          : chunk.length;
        // Cast record elements
        for (let i = 0; i < length; i++) {
          const field = chunk[i];
          const [err, value] = this.__cast(field, {
            index: i,
            column: i,
            records: this.info.records,
            header: chunkIsHeader,
          });
          if (err) return [err];
          record[i] = [value, field];
        }
        // Record is a literal object
        // `columns` is always defined: it is either provided or discovered.
      } else {
        for (let i = 0; i < columns.length; i++) {
          const field = get(chunk, columns[i].key);
          const [err, value] = this.__cast(field, {
            index: i,
            column: columns[i].key,
            records: this.info.records,
            header: chunkIsHeader,
          });
          if (err) return [err];
          record[i] = [value, field];
        }
      }
      let csvrecord = "";
      for (let i = 0; i < record.length; i++) {
        let options, err;

        let [value, field] = record[i];
        if (typeof value === "string") {
          options = this.options;
        } else if (is_object(value)) {
          // Value is considerered as a mix of a value and options
          options = { ...value };
          value = options.value;
          delete options.value;
          if (
            typeof value !== "string" &&
            value !== undefined &&
            value !== null
          ) {
            return [
              Error(
                `Invalid Casting Value: returned value must return a string, null or undefined, got ${JSON.stringify(value)}`,
              ),
            ];
          }
          // Merge global options with the ones returned by cast
          options = { ...this.options, ...options };
          [err, options] = normalize_options(options);
          if (err !== undefined) {
            return [err];
          }
        } else if (value === undefined || value === null) {
          options = this.options;
        } else {
          return [
            Error(
              `Invalid Casting Value: returned value must return a string, an object, null or undefined, got ${JSON.stringify(value)}`,
            ),
          ];
        }
        const {
          delimiter,
          escape,
          quote,
          relax_quotes,
          quoted,
          quoted_empty,
          quoted_string,
          quoted_match,
          record_delimiter,
          quote_record_delimiter,
          escape_formulas,
        } = options;
        if ("" === value && "" === field) {
          const quotedMatch = matches_quoted_match(value, quoted_match);
          const shouldQuote =
            quotedMatch ||
            true === quoted_empty ||
            (true === quoted_string && false !== quoted_empty);
          if (shouldQuote === true) {
            value = quote + value + quote;
          }
          csvrecord += value;
        } else if (value) {
          if (typeof value !== "string") {
            return [
              Error(
                `Formatter must return a string, null or undefined, got ${JSON.stringify(value)}`,
              ),
            ];
          }
          const containsdelimiter = emits_separator(value, [delimiter]);
          const containsQuote = quote !== "" && value.indexOf(quote) >= 0;
          const containsEscape = value.indexOf(escape) >= 0 && escape !== quote;
          // Testing `\n` and `\r` covers the three sequences `parse` discovers
          const containsRecordDelimiter = emits_separator(value, [
            record_delimiter,
            ...(quote_record_delimiter === false ? [] : ["\n", "\r"]),
          ]);
          const quotedString = quoted_string && typeof field === "string";
          const quotedMatch = matches_quoted_match(value, quoted_match);
          // See https://github.com/adaltas/node-csv/pull/387
          // More about CSV injection or formula injection, when websites embed
          // untrusted input inside CSV files:
          // https://owasp.org/www-community/attacks/CSV_Injection
          // http://georgemauer.net/2017/10/07/csv-injection.html
          // Apple Numbers unicode normalization is empirical from testing
          if (escape_formulas) {
            switch (value[0]) {
              case "-":
                if (typeof field === "number" || typeof field === "bigint") {
                  break;
                }
                value = `'${value}`;
                break;
              case "=":
              case "+":
              case "@":
              case "\t":
              case "\r":
              case "\uFF1D": // Unicode '='
              case "\uFF0B": // Unicode '+'
              case "\uFF0D": // Unicode '-'
              case "\uFF20": // Unicode '@'
                value = `'${value}`;
                break;
            }
          }
          const shouldQuote =
            (containsQuote === true &&
              (relax_quotes === false ||
                value.trimStart().startsWith(quote))) ||
            containsdelimiter ||
            containsRecordDelimiter ||
            quoted ||
            quotedString ||
            quotedMatch;
          // Escape all escape characters if quoted
          if (shouldQuote === true && containsEscape === true) {
            value = value.replaceAll(escape, () => escape + escape);
          }
          // Escape all quote characters if quoted
          if (shouldQuote === true) {
            value = value.replaceAll(quote, () => escape + quote);
          }
          if (shouldQuote === true) {
            value = quote + value + quote;
          }
          csvrecord += value;
        } else if (
          quoted_empty === true ||
          (field === "" && quoted_string === true && quoted_empty !== false)
        ) {
          csvrecord += quote + quote;
        }
        if (i !== record.length - 1) {
          csvrecord += delimiter;
        }
      }
      return [undefined, csvrecord];
    },
    bom: function (push) {
      if (this.options.bom !== true) {
        return;
      }
      push(bom_utf8);
    },
    headers: function (push) {
      if (this.options.header === false) {
        return;
      }
      if (this.options.columns === undefined) {
        return;
      }
      let err;
      let headers = this.options.columns.map((column) => column.header);
      if (this.options.eof) {
        [err, headers] = this.stringify(headers, true);
        headers += this.options.record_delimiter;
      } else {
        [err, headers] = this.stringify(headers, true);
      }
      if (err) return err;
      if (this.options.header_as_comment) {
        headers = this.options.header_as_comment + " " + headers;
      }
      push(headers);
    },
    __cast: function (value, context) {
      const type = typeof value;
      try {
        if (type === "string") {
          // Fine for 99% of the cases
          return [undefined, this.options.cast.string(value, context)];
        } else if (type === "bigint") {
          return [undefined, this.options.cast.bigint(value, context)];
        } else if (type === "number") {
          return [undefined, this.options.cast.number(value, context)];
        } else if (type === "boolean") {
          return [undefined, this.options.cast.boolean(value, context)];
        } else if (value instanceof Date) {
          return [undefined, this.options.cast.date(value, context)];
        } else if (type === "object" && value !== null) {
          return [undefined, this.options.cast.object(value, context)];
        } else if (value === null && this.options.cast.null !== undefined) {
          return [undefined, this.options.cast.null(value, context)];
        } else if (
          value === undefined &&
          this.options.cast.undefined !== undefined
        ) {
          return [undefined, this.options.cast.undefined(value, context)];
        } else {
          return [undefined, value];
        }
      } catch (err) {
        return [err];
      }
    },
  };
};

/*
CSV Stringify

Please look at the [Sync API](https://csv.js.org/stringify/api/sync/) for
additional information.
*/


const stringify = function (records, opts = {}) {
  const data = [];
  const [err, options] = normalize_options(opts);
  if (err !== undefined) throw err;
  const state = {
    stop: false,
    // Set while records are buffered for automatic delimiter discovery
    pending_delimiter_auto: options.delimiter_auto !== undefined,
  };
  // Information
  const info = {
    records: 0,
  };
  const api = stringifier(options, state, info);
  for (const record of records) {
    const err = api.__transform(record, function (record) {
      data.push(record);
    });
    if (err !== undefined) throw err;
  }
  // Finalize automatic delimiter discovery with the buffered records. Empty
  // inputs keep their historical header-only / empty-string behavior.
  if (state.pending_delimiter_auto === true && api.state_auto.buffer.length > 0) {
    const err = api.__delimiter_auto_finalize((record) => {
      data.push(record);
    });
    if (err !== undefined) throw err;
  }
  if (data.length === 0) {
    api.bom((d) => {
      data.push(d);
    });
    const err = api.headers((headers) => {
      data.push(headers);
    });
    if (err !== undefined) throw err;
  }
  return data.join("");
};

exports.normalize_options = normalize_options;
exports.stringify = stringify;
