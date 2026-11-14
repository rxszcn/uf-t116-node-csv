import "should";
import { parse, stringify } from "../lib/sync.js";

// End-to-end pipeline matrix covering the three `delimiter` configuration
// forms on both the parsing and the stringifying sides, for both discoverable
// and undiscoverable payloads. It also proves that the automatic discovery
// sampling and scoring converge to the same delimiter on both sides.
describe("pipeline delimiter literal auto", function () {
  const discoverable = "a;b;c\n1;2;3\n4;5;6";
  const undiscoverable = "alpha\nbeta\ngamma";

  describe("three configuration forms", function () {
    it("literal auto: parsing discovers the semicolon", function () {
      parse(discoverable, { delimiter: "auto" }).should.eql([
        ["a", "b", "c"],
        ["1", "2", "3"],
        ["4", "5", "6"],
      ]);
    });

    it("omitted: parsing keeps the comma default (single column)", function () {
      parse(discoverable, {}).should.eql([["a;b;c"], ["1;2;3"], ["4;5;6"]]);
    });

    it("explicit: parsing uses the provided delimiter verbatim", function () {
      parse(discoverable, { delimiter: ";" }).should.eql([
        ["a", "b", "c"],
        ["1", "2", "3"],
        ["4", "5", "6"],
      ]);
    });
  });

  describe("undiscoverable payload", function () {
    it("parsing fails loudly with literal auto", function () {
      (() => parse(undiscoverable, { delimiter: "auto" })).should.throw({
        code: "CSV_DELIMITER_NOT_DISCOVERED",
      });
    });

    it("parsing fails loudly with delimiter_auto:true (no rollback)", function () {
      (() => parse(undiscoverable, { delimiter_auto: true })).should.throw({
        code: "CSV_DELIMITER_NOT_DISCOVERED",
      });
    });

    it("an explicit delimiter still parses the payload", function () {
      parse(undiscoverable, { delimiter: "," }).should.eql([
        ["alpha"],
        ["beta"],
        ["gamma"],
      ]);
    });
  });

  describe("both sides converge on the same delimiter", function () {
    const cases = [
      { delimiter: ";" },
      { delimiter: "," },
      { delimiter: ":" },
      { delimiter: "." },
    ];

    for (const { delimiter } of cases) {
      it(`converges on ${JSON.stringify(delimiter)} for both sides`, function () {
        // Parsing side: plain, unquoted rows joined by the delimiter. The
        // discovery pre-parser splits records without interpreting field
        // quotes, so the probe deliberately avoids quoted fields.
        const source = [
          "a" + delimiter + "b" + delimiter + "c",
          "1" + delimiter + "2" + delimiter + "3",
        ].join("\n");
        const parsed = parse(source, { delimiter: "auto" });
        parsed.should.eql([
          ["a", "b", "c"],
          ["1", "2", "3"],
        ]);
        // Writing side: embed the same delimiter inside the field values so it
        // is a structurally consistent candidate across every record.
        const rows = [
          ["a" + delimiter + "1", "b" + delimiter + "2"],
          ["c" + delimiter + "3", "e" + delimiter + "4"],
        ];
        const output = stringify(rows, { delimiter: "auto", eof: false });
        // Fields containing the discovered delimiter are quoted and joined
        // with the exact same delimiter the parsing side discovered.
        output.should.eql(
          rows
            .map((row) => row.map((field) => `"${field}"`).join(delimiter))
            .join("\n"),
        );
        // Round trip: reading the output with the converged delimiter recovers
        // the original records.
        parse(output, { delimiter }).should.eql(rows);
      });
    }

    it("the writing side rejects the same undiscoverable data", function () {
      const records = parse(undiscoverable, { delimiter: "," });
      (() => stringify(records, { delimiter: "auto" })).should.throw({
        code: "CSV_OPTION_DELIMITER_AUTO_UNDISCOVERABLE",
      });
    });
  });

  describe("full parse -> transform -> stringify round trip", function () {
    it("keeps columns aligned end to end with literal auto", function () {
      const records = parse(discoverable, { delimiter: "auto" });
      const output = stringify(
        records.map((row) => row.map((v) => "[" + v + "]")),
        { delimiter: ";", eof: false },
      );
      output.should.eql("[a];[b];[c]\n[1];[2];[3]\n[4];[5];[6]");
    });
  });
});
