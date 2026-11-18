// File-name template renderer for PDF downloads (src/utils/file-name.ts).
// Pure function over a template string; the only ambient input is QBO_PDF_FILE_NAME.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { renderFileName } from "../../src/utils/file-name.js";

// Invented fixtures only — this repository is public (CLAUDE.md).
const VALUES = { date: "2026-11-18", type: "Purchase Order", ref: "PO1001", id: "297" };

const ENV_KEY = "QBO_PDF_FILE_NAME";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

describe("renderFileName", () => {
  it("name-default-template: renders '{date} {type} {ref}.pdf' with the date's dashes removed", () => {
    assert.equal(renderFileName(VALUES), "20261118 Purchase Order PO1001.pdf");
  });

  it("name-each-placeholder: substitutes {id}, {ref}, {type} and {date}", () => {
    assert.equal(
      renderFileName(VALUES, "{id}-{ref}-{type}-{date}"),
      "297-PO1001-Purchase Order-20261118.pdf",
    );
  });

  it("name-ref-falls-back-to-id: a missing ref renders as the id", () => {
    assert.equal(
      renderFileName({ date: "2026-11-18", type: "Purchase Order", id: "297" }),
      "20261118 Purchase Order 297.pdf",
    );
  });

  it("name-ref-falls-back-to-id: a blank ref renders as the id", () => {
    assert.equal(
      renderFileName({ ...VALUES, ref: "   " }),
      "20261118 Purchase Order 297.pdf",
    );
  });

  it("name-neutralizes-path-chars: separators, dots and control characters never survive", () => {
    for (const ref of ["A/B", "A\\B", "..", "A\u0000B", "A\nB", "../etc"]) {
      const name = renderFileName({ ...VALUES, ref }, "{ref}");
      assert.ok(!name.includes("/"), `slash in ${JSON.stringify(name)}`);
      assert.ok(!name.includes("\\"), `backslash in ${JSON.stringify(name)}`);
      assert.ok(!CONTROL.test(name), `control char in ${JSON.stringify(name)}`);
      assert.notEqual(name, ".");
      assert.notEqual(name, "..");
      assert.ok(!name.startsWith("../"), `traversal in ${JSON.stringify(name)}`);
    }
  });

  it("name-neutralizes-path-chars: replaces separators with '-'", () => {
    assert.equal(renderFileName({ ...VALUES, ref: "A/B" }, "{ref}"), "A-B.pdf");
    assert.equal(renderFileName({ ...VALUES, ref: "A\\B" }, "{ref}"), "A-B.pdf");
  });

  it("name-refuses-bad-template: an unknown placeholder throws and is named", () => {
    assert.throws(() => renderFileName(VALUES, "{date} {nope}"), /nope/);
  });

  it("name-refuses-bad-template: a template rendering empty throws", () => {
    assert.throws(() => renderFileName({ ...VALUES, ref: "x" }, "   "), /empty/i);
  });

  it("name-refuses-bad-template: a template rendering '.' or '..' throws", () => {
    assert.throws(() => renderFileName(VALUES, "."), /\./);
    assert.throws(() => renderFileName(VALUES, ".."), /\./);
  });

  it("name-refuses-separator-in-template: literal '/' or '\\' in the template throws", () => {
    assert.throws(() => renderFileName(VALUES, "../x/{ref}"), /path separator/i);
    assert.throws(() => renderFileName(VALUES, "a\\{ref}"), /path separator/i);
  });

  it("name-appends-pdf-once: exactly one .pdf extension, case-insensitive", () => {
    assert.equal(renderFileName(VALUES, "{ref}"), "PO1001.pdf");
    assert.equal(renderFileName(VALUES, "{ref}.pdf"), "PO1001.pdf");
    const upper = renderFileName(VALUES, "{ref}.PDF");
    assert.equal(upper.toLowerCase(), "po1001.pdf");
    assert.ok(!/\.pdf\.pdf$/i.test(upper));
  });

  it("name-env-default: QBO_PDF_FILE_NAME is the default template, read at call time", () => {
    process.env[ENV_KEY] = "{ref}";
    assert.equal(renderFileName(VALUES), "PO1001.pdf");
  });

  it("name-env-default: an explicit template argument wins over the env var", () => {
    process.env[ENV_KEY] = "{ref}";
    assert.equal(renderFileName(VALUES, "{id}"), "297.pdf");
  });
});
