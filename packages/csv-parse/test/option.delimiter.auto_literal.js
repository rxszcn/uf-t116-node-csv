import "should";
import { parse, normalize_options } from "../lib/index.js";
import { parse as parse_sync } from "../lib/sync.js";

// Regression matrix for the literal "auto" delimiter value.
// Configuration forms: literal "auto" | omitted | explicit delimiter.
// Payload shapes: discoverable (a stable multi-column delimiter) and
// undiscoverable (a single column without any trustworthy candidate).
describe("Option `delimiter` literal auto", function () {
  const discoverable = "a;b;c\n1;2;3\n4;5;6";
  const undiscoverable = "alpha\nbeta\ngamma";

  describe("normalization", function () {
    it("treats the literal string auto as automatic discovery", function () {
      const options = normalize_options({ delimiter: "auto" });
      options.delimiter_auto.should.not.eql(false);
      options.delimiter.should.eql([]);
    });

    it("treats a buffer auto as automatic discovery", function () {
      const options = normalize_options({ delimiter: Buffer.from("auto") });
      options.delimiter_auto.should.not.eql(false);
      options.delimiter.should.eql([]);
    });

    it("an omitted delimiter keeps the historical comma default", function () {
      const options = normalize_options({});
      options.delimiter_auto.should.eql(false);
      options.delimiter.should.eql([Buffer.from(",")]);
    });

    it("an explicit delimiter is preserved verbatim", function () {
      const options = normalize_options({ delimiter: ";" });
      options.delimiter_auto.should.eql(false);
      options.delimiter.should.eql([Buffer.from(";")]);
    });

    it("honors an explicit delimiter_auto:false even with delimiter auto", function () {
      const options = normalize_options({
        delimiter: "auto",
        delimiter_auto: false,
      });
      options.delimiter_auto.should.eql(false);
      options.delimiter.should.eql([Buffer.from(",")]);
    });
  });

  describe("discoverable payload", function () {
    it("literal auto discovers the semicolon delimiter", function () {
      parse_sync(discoverable, { delimiter: "auto" }).should.eql([
        ["a", "b", "c"],
        ["1", "2", "3"],
        ["4", "5", "6"],
      ]);
    });

    it("omitted delimiter keeps the comma default (single column)", function () {
      parse_sync(discoverable, {}).should.eql([
        ["a;b;c"],
        ["1;2;3"],
        ["4;5;6"],
      ]);
    });

    it("explicit delimiter behaves verbatim", function () {
      parse_sync(discoverable, { delimiter: ";" }).should.eql([
        ["a", "b", "c"],
        ["1", "2", "3"],
        ["4", "5", "6"],
      ]);
    });

    it("literal auto and delimiter_auto:true converge on the same result", function () {
      parse_sync(discoverable, { delimiter: "auto" }).should.eql(
        parse_sync(discoverable, { delimiter_auto: true }),
      );
    });
  });

  describe("undiscoverable payload", function () {
    it("literal auto fails loudly instead of silently ingesting one column", function () {
      (() => parse_sync(undiscoverable, { delimiter: "auto" })).should.throw({
        code: "CSV_DELIMITER_NOT_DISCOVERED",
      });
    });

    it("delimiter_auto:true keeps failing on undiscoverable data (no rollback)", function () {
      (() => parse_sync(undiscoverable, { delimiter_auto: true })).should.throw(
        {
          code: "CSV_DELIMITER_NOT_DISCOVERED",
        },
      );
    });

    it("an explicit delimiter still parses the data verbatim", function () {
      parse_sync(undiscoverable, { delimiter: "," }).should.eql([
        ["alpha"],
        ["beta"],
        ["gamma"],
      ]);
    });

    it("surfaces the discovery error through the stream callback", function (next) {
      parse(undiscoverable, { delimiter: "auto" }, (err) => {
        err.should.have.property("code", "CSV_DELIMITER_NOT_DISCOVERED");
        next();
      });
    });
  });

  describe("edge cases", function () {
    it("empty input resolves to no records (historical behavior)", function () {
      parse_sync("", { delimiter: "auto" }).should.eql([]);
    });

    it("discovers correctly when the sampling window truncates a record", function (next) {
      let content = "";
      for (let i = 0; i < 100; i++) {
        content += i + ":abc:def:hij:klm:nop:qrs:tuv:wxyz" + "\n";
      }
      const parser = parse(
        { delimiter: "auto", delimiter_auto: { size: 20 } },
        (err, data) => {
          if (err) return next(err);
          data
            .map((r) => r.join(":"))
            .join("\n")
            .should.eql(content.trim());
          next();
        },
      );
      for (let i = 0; i < content.length; i++) {
        parser.write(content.slice(i, i + 1));
      }
      parser.end();
    });
  });
});
