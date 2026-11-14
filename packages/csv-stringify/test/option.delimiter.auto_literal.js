import "should";
import { stringify } from "../lib/index.js";
import { stringify as stringify_sync, normalize_options } from "../lib/sync.js";

// Regression matrix for the literal "auto" delimiter value on the writing
// side. Configuration forms: literal "auto" | omitted | explicit delimiter.
// Payload shapes: discoverable (a candidate repeated consistently across
// records) and undiscoverable (no trustworthy shared candidate).
describe("Option `delimiter` literal auto", function () {
  // The semicolon appears once inside each record's field values, splitting
  // every record into the same number of fragments, so it is discoverable.
  const discoverable = [
    ["a;b", "c"],
    ["d;e", "f"],
  ];
  // No character is shared across the two records, so nothing is trustworthy.
  const undiscoverable = [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ];

  describe("normalization", function () {
    it("marks the literal string auto for automatic discovery", function () {
      const [err, options] = normalize_options({ delimiter: "auto" });
      (err === undefined).should.be.true();
      (options.delimiter_auto !== undefined).should.be.true();
      // The internal discovery config must not alter the public option shape
      Object.keys(options).should.not.containEql("delimiter_auto");
    });

    it("marks a buffer auto for automatic discovery", function () {
      const [err, options] = normalize_options({
        delimiter: Buffer.from("auto"),
      });
      (err === undefined).should.be.true();
      (options.delimiter_auto !== undefined).should.be.true();
    });

    it("an omitted delimiter defaults to comma without discovery", function () {
      const [err, options] = normalize_options({});
      (err === undefined).should.be.true();
      options.delimiter.should.eql(",");
      (options.delimiter_auto === undefined).should.be.true();
    });

    it("an explicit delimiter is preserved verbatim without discovery", function () {
      const [err, options] = normalize_options({ delimiter: ";" });
      (err === undefined).should.be.true();
      options.delimiter.should.eql(";");
      (options.delimiter_auto === undefined).should.be.true();
    });
  });

  describe("discoverable records", function () {
    it("literal auto discovers and applies the semicolon", function () {
      // Fields containing the discovered semicolon are quoted to round-trip.
      stringify_sync(discoverable, {
        delimiter: "auto",
        eof: false,
      }).should.eql('"a;b";c\n"d;e";f');
    });

    it("omitted delimiter keeps the comma default", function () {
      // The fields contain a semicolon but not a comma, so the comma
      // delimiter does not force any quoting.
      stringify_sync(discoverable, { eof: false }).should.eql("a;b,c\nd;e,f");
    });

    it("explicit delimiter behaves verbatim", function () {
      stringify_sync(discoverable, {
        delimiter: ";",
        eof: false,
      }).should.eql('"a;b";c\n"d;e";f');
    });
  });

  describe("undiscoverable records", function () {
    it("literal auto fails loudly instead of fusing columns", function () {
      (() =>
        stringify_sync(undiscoverable, { delimiter: "auto" })).should.throw({
        code: "CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE",
      });
    });

    it("an explicit delimiter still writes the data verbatim", function () {
      stringify_sync(undiscoverable, {
        delimiter: ";",
        eof: false,
      }).should.eql("a;b;c\n1;2;3");
    });

    it("the omitted comma default still writes the data", function () {
      stringify_sync(undiscoverable, { eof: false }).should.eql("a,b,c\n1,2,3");
    });

    it("surfaces the discovery error through the stream callback", function (next) {
      stringify(undiscoverable, { delimiter: "auto" }, (err) => {
        err.should.have.property(
          "code",
          "CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE",
        );
        next();
      });
    });
  });

  describe("edge cases", function () {
    it("empty input keeps the historical empty-string behavior", function () {
      stringify_sync([], { delimiter: "auto" }).should.eql("");
    });

    it("a single record cannot establish a delimiter and fails", function () {
      (() =>
        stringify_sync([["a", "b", "c"]], { delimiter: "auto" })).should.throw({
        code: "CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE",
      });
    });

    it("object records are discovered from their cast field values", function () {
      const records = [
        { x: "1;2", y: "z" },
        { x: "3;4", y: "w" },
      ];
      stringify_sync(records, {
        delimiter: "auto",
        eof: false,
      }).should.eql('"1;2";z\n"3;4";w');
    });
  });
});
