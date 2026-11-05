# Forms and conditions

<!-- description: The sixteen form controls of enform, sections, per-step visibility and editability, and the rules that show, hide, collapse, require, lock or skip fields from one JSON expression tree the visual condition builder writes. -->

Each step of a flow shows a form. The form is part of the flow definition, so it is versioned, diffable and the same whether it was built in the browser or in a file. The server runs every rule and every validation again at each submission; it never trusts the client's view of the form.

## Controls

| Control | Captures |
|---|---|
| `text` | One line of text. |
| `long-text` | Several lines of text. |
| `number` | A number. |
| `money` | An amount. |
| `date` | A date. |
| `select` | One option from a list. |
| `multi-select` | Several options from a list. |
| `checkbox` | A checked state. |
| `radio` | One option, each shown. |
| `yes-no` | Yes or no. |
| `email` | An email address. |
| `phone` | A phone number. |
| `file` | A file upload. |
| `user` | A person from the directory. A step can target the person chosen here (`field:<key>`). |
| `static` | Text the form shows and does not capture. |
| `repeating` | A section the author can repeat: a list of rows with the same fields. |

Each field has a key, a label, optional help text, and whether it is required. Choice controls have an option list. A person with `flow.edit` can change labels, help text and options; adding or removing a field needs `flow.build`.

## Sections

A section groups fields under a heading, and can be collapsed by default. A rule can show, hide, collapse, require, lock or skip a whole section.

## Visible and editable per step

Each step lists which fields it shows and which fields its holder may edit. A registrar step can show the student's request read-only and add its own fields. A field that a step does not show is not sent to that step's holder at all; the server enforces this, not the page.

## Rules

A rule is one condition with one effect on the fields and sections it targets:

```json
{ "when": { ">": [{ "var": "overload_credits" }, 2] }, "effect": "require", "targets": ["justification"] }
```

| Effect | Does |
|---|---|
| `show`, `hide` | Presentation only. A hidden field keeps its value. |
| `collapse` | Collapses a section. |
| `require` | Makes the targets required. |
| `lock` | Makes the targets read-only. |
| `skip` | Drops the targets from the step's capture: absent from the view, not required, not recorded. |

Rules apply in document order and a later rule wins per target. A condition reads the instance's values at the root, plus the reserved `context` root: `context.step` is the current step and `context.user` the acting principal, so a rule can depend on data, on the step and on the person.

A step's **skip when** condition uses the same expression format and skips the whole step. The timeline then records the step as skipped with the condition, for example "chair skipped: overload_credits ≤ 2".

## One expression format

Every condition is a JSON expression tree in the JSON Logic form. The visual condition builder writes it ("Skip this step when [Overload credits] [≤] [2]"), and a developer writes it in the file. The two are the same tree, so a condition written in the builder round-trips through `enform flow pull` and back. The engine evaluates a path read (`var`), the comparisons (`==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=`), the logic operators (`and`, `or`, `not`, `if`, `!!`) and arithmetic (`+`, `-`, `*`, `/`, `%`). An unknown operator or a path the data does not have is an error, never a silent false. The condition builder draws comparisons, all-of, any-of and not; a tree it cannot draw is shown as JSON and kept intact.

A TypeScript rule as one more node type of the same tree, run in a sandbox with CPU, memory and time limits and no network access, is part of the design (ADR 0008) and not yet in the engine.

## Validation

The server validates each submission against the published version the instance runs on: required fields, control types, option lists, and every rule. A refusal names the field and the reason, and the interface shows it on the field. The values a step captured are recorded with the step's completion and read back through the public API only.

## Printing

Each instance renders as a PDF for the current step (`/api/v1/instances/<id>/pdf`), with the same visibility rules as the page. The task page links to it.
