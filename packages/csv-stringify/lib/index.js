/*
CSV Stringify

Please look at the [project documentation](https://csv.js.org/stringify/) for
additional information.
*/

import { Transform } from "stream";
import { CsvError } from "./api/CsvError.js";
import { is_object } from "./utils/is_object.js";
import { stringifier } from "./api/index.js";
import { normalize_options } from "./api/normalize_options.js";

class Stringifier extends Transform {
  constructor(opts = {}) {
    super({ ...{ writableObjectMode: true }, ...opts });
    const [err, options] = normalize_options(opts);
    if (err !== undefined) throw err;
    // Expose options
    this.options = options;
    // Internal state
    this.state = {
      stop: false,
      // Set while records are buffered for automatic delimiter discovery
      pending_delimiter_auto: options.delimiter_auto !== undefined,
    };
    // Information
    this.info = {
      records: 0,
    };
    this.api = stringifier(this.options, this.state, this.info);
    this.api.options.on_record = (...args) => {
      this.emit("record", ...args);
    };
  }
  _transform(chunk, encoding, callback) {
    if (this.state.stop === true) {
      return;
    }
    const err = this.api.__transform(chunk, this.push.bind(this));
    if (err !== undefined) {
      this.state.stop = true;
    }
    callback(err);
  }
  _flush(callback) {
    if (this.state.stop === true) {
      // Note, Node.js 12 call flush even after an error, we must prevent
      // `callback` from being called in flush without any error.
      return;
    }
    // Finalize automatic delimiter discovery with the records collected so
    // far. No record at all (header-only/empty output) falls back to the
    // comma default instead of failing, matching the empty-input behavior.
    if (
      this.state.pending_delimiter_auto === true &&
      this.api.state_auto.buffer.length > 0
    ) {
      const err = this.api.__delimiter_auto_finalize(this.push.bind(this));
      if (err !== undefined) return callback(err);
    }
    if (this.info.records === 0) {
      this.api.bom(this.push.bind(this));
      const err = this.api.headers(this.push.bind(this));
      if (err) return callback(err);
    }
    callback();
  }
}

const stringify = function () {
  let data, options, callback;
  for (const i in arguments) {
    const argument = arguments[i];
    const type = typeof argument;
    if (data === undefined && Array.isArray(argument)) {
      data = argument;
    } else if (options === undefined && is_object(argument)) {
      options = argument;
    } else if (callback === undefined && type === "function") {
      callback = argument;
    } else {
      throw new CsvError("CSV_INVALID_ARGUMENT", [
        "Invalid argument:",
        `got ${JSON.stringify(argument)} at index ${i}`,
      ]);
    }
  }
  const stringifier = new Stringifier(options);
  if (callback) {
    const chunks = [];
    stringifier.on("readable", function () {
      let chunk;
      while ((chunk = this.read()) !== null) {
        chunks.push(chunk);
      }
    });
    stringifier.on("error", function (err) {
      callback(err);
    });
    stringifier.on("end", function () {
      try {
        callback(undefined, chunks.join(""));
      } catch (err) {
        // This can happen if the `chunks` is extremely long; it may throw
        // "Cannot create a string longer than 0x1fffffe8 characters"
        // See [#386](https://github.com/adaltas/node-csv/pull/386)
        callback(err);
        return;
      }
    });
  }
  if (data !== undefined) {
    const writer = function () {
      for (const record of data) {
        stringifier.write(record);
      }
      stringifier.end();
    };
    // Support Deno, Rollup doesn't provide a shim for setImmediate
    if (typeof setImmediate === "function") {
      setImmediate(writer);
    } else {
      setTimeout(writer, 0);
    }
  }
  return stringifier;
};

export { stringify, CsvError, Stringifier, normalize_options };
