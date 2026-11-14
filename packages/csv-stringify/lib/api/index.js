import { get } from "../utils/get.js";
import { is_object } from "../utils/is_object.js";
import { CsvError } from "./CsvError.js";
import { normalize_columns } from "./normalize_columns.js";
import { normalize_options } from "./normalize_options.js";
import {
  delimiter_records,
  delimiter_score,
} from "../utils/delimiter_discover.js";
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

export { stringifier };
