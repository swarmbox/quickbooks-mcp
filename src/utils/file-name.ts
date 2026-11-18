// File-name template renderer for saved PDFs.
// Pure apart from reading QBO_PDF_FILE_NAME at call time. The caller chooses the folder;
// this helper only guarantees the rendered name cannot escape it.

/** Template used when neither an argument nor QBO_PDF_FILE_NAME supplies one. */
export const DEFAULT_PDF_FILE_NAME_TEMPLATE = "{date} {type} {ref}.pdf";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const SEPARATOR_OR_CONTROL_G = /[/\\\u0000-\u001f\u007f]/g;

/**
 * Replace path separators and control characters with `-` so a value stays inside one name.
 * A value of only dots (`.`, `..`) is replaced too, so it can never stand as a dot-only name.
 */
function neutralize(value: string): string {
  const safe = value.replace(SEPARATOR_OR_CONTROL_G, "-");
  return /^\.+$/.test(safe) ? "-" : safe;
}

/**
 * Render a PDF file name from a template.
 *
 * Placeholders (any other `{…}` token is refused):
 * - `{date}` — the TxnDate `YYYY-MM-DD` without dashes (empty when no date)
 * - `{type}` — a readable entity label, e.g. `Purchase Order`
 * - `{ref}`  — the document number; falls back to the id when blank or missing
 * - `{id}`   — the QuickBooks entity id
 *
 * The template is the `template` argument, else `QBO_PDF_FILE_NAME`, else
 * {@link DEFAULT_PDF_FILE_NAME_TEMPLATE}. Values have `/`, `\` and control characters replaced
 * with `-`; the result is trimmed, refused if empty, `.`, `..` or still holding a separator or
 * control character (from the template's own text), and ends in exactly one `.pdf`.
 */
export function renderFileName(
  values: { date?: string; type: string; ref?: string; id: string },
  template?: string,
): string {
  const tpl = template ?? process.env.QBO_PDF_FILE_NAME ?? DEFAULT_PDF_FILE_NAME_TEMPLATE;

  const ref = values.ref?.trim() ? values.ref : values.id;
  const substitutions: Record<string, string> = {
    date: (values.date ?? "").replace(/-/g, ""),
    type: values.type,
    ref,
    id: values.id,
  };

  const rendered = tpl.replace(/\{([^{}]*)\}/g, (_token, name: string) => {
    if (!Object.hasOwn(substitutions, name)) {
      throw new Error(
        `Unknown placeholder {${name}} in file name template. Use {date}, {type}, {ref} or {id}.`,
      );
    }
    return neutralize(substitutions[name]);
  });

  const name = rendered.trim();
  if (name === "" || name === "." || name === "..") {
    throw new Error(`File name template renders to an empty or dot-only name (${JSON.stringify(name)}).`);
  }
  if (/[/\\]/.test(name) || CONTROL_CHARS.test(name)) {
    throw new Error("File name may not contain a path separator or control character.");
  }

  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}
