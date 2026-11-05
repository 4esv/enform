# The builder

<!-- description: Design a flow in the browser with enform's multiplayer builder: steps, sections, fields and conditions, sharing with presets, a dry run with a simulated clock, the version difference, and publishing. -->

The builder is where a flow is designed in the browser. It edits the draft of one flow through the same public API that the CLI uses, and the engine decides what is valid, who may change what, and what a publication records. Open it from the flows list, or at `/?flow=<slug>&builder=1`.

## Create a flow

Choose **New flow** on the flows list (`/?new=1`), give it a slug and a title. The new flow has a draft with one request step. Its creator holds `flow.build` on it.

## Steps

Each step has a key, its targets, its outcomes and its form. Add a step, move it, or remove it. Structural changes need the `flow.build` scope; a person with `flow.edit` only can change labels, help text, option lists and email copy, and the structural controls are disabled for them.

For each step the settings panel sets:

- **Targets**: users, groups, teams, `starter`, a user field of the form, or the manager of the starter. See [Routing](routing.md).
- **Outcomes**: the choices the holder sees, such as approve, reject, send back.
- **Skip when**: a condition that skips the step. The condition builder writes it in plain language: "Skip this step when Overload credits ≤ 2".
- **Reminder** interval and **deadline** with the targets the escalation adds. See [Routing](routing.md).
- **Takeover**: always, after an idle period, or never.
- **Visible** and **editable** fields of the step.

The flow itself has settings for the undo window in hours, the final step, and whether anonymous access is allowed. Anonymous access shows a visible label in the builder and on the form.

## Sections, fields and conditions

A step's form is a list of fields, optionally grouped in sections. The sixteen controls and the rules that show, hide, collapse, require, lock or skip a field or a section are described in [Forms and conditions](forms.md).

## Editing together

More than one person can edit a draft at the same time. The header shows who else is in the builder and at which field. Every edit is an operation; the server merges edits to different parts of the definition, and only a change to the same path by two people at the same time is reported as a conflict to the second writer. A change made elsewhere is applied when you have no unsaved edits, and announced when you have.

## Sharing

The sharing panel lists the grants of the flow as scopes, with the principal and the resource. It adds a grant for a user, a group or a team, on the flow or on one step, either as explicit scopes or through a preset:

| Preset | Scopes |
|---|---|
| Starter | `instance.start` on the flow |
| Approver | `step.outcome:approve`, `step.outcome:reject` on a step |
| Reviewer | `step.outcome:send_back` on a step |
| Viewer | `instance.read`, `instance.timeline` on the flow |
| Editor | `flow.edit`, `flow.dryrun`, `instance.read`, `instance.timeline`, `task.reassign` on the flow |
| Builder | Editor plus `flow.build` |

A preset expands to scopes when the grant is made. The engine stores only scopes, and the API lists only scopes. Filtering the panel by a step answers "Who can approve at the registrar step?" without reading any code. Each grant change shows in the change feed with its author and time.

## Dry run

The dry-run panel runs the draft or any published version against sample data, without side effects:

- the **route**: each step as active or skipped, with the condition that skipped it;
- the **assignees** of each active step and the target they resolve through;
- the **preview inbox**: the emails the next step would send;
- the **timers**: a simulated clock moves forward by minutes or days, and the reminders and the escalation that fire show in the inbox.

Running as another person needs the `org.impersonate` scope, and the log records each use. Nothing else of a dry run is stored, and a dry run never shows in live views.

## Versions and differences

The builder shows the published versions with their content hashes and, for each, the field-level difference from its parent with the author of each change. The difference between a version and the draft shows what a publication would change.

## Publish

**Publish** freezes the draft as the next version. Submissions in progress stay on the version they started on. An open draft submission on the old version moves to the new one when its author opens it again: it keeps every value that fits, highlights a new required field, and shows a value that no longer fits without deleting it.

## The same flow as a file

Everything the builder does, the CLI does from a file: `enform flow pull` writes the draft in its canonical form, `enform flow push` turns the file's differences into operations, `enform flow diff` shows the difference between versions, `enform flow dry-run` runs the dry run, and `enform flow publish` publishes. A developer and a coordinator edit the same draft; neither blocks the other. See the [CLI reference](cli.md).
