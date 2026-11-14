/*
CSV Stringify

Please look at the [Sync API](https://csv.js.org/stringify/api/sync/) for
additional information.
*/

import { stringifier } from "./api/index.js";
import { normalize_options } from "./api/normalize_options.js";

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
  if (
    state.pending_delimiter_auto === true &&
    api.state_auto.buffer.length > 0
  ) {
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

export { stringify, normalize_options };
