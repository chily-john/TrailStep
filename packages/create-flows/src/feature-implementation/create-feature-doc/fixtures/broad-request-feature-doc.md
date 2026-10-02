# Weekly Summary CSV Export

## Must-Have Outcome

Admins can export the existing weekly summary table as a CSV from the current dashboard, using the filters that already exist on that table.

## Users / Jobs / Pain

- Admins need to provide leadership with the weekly workspace summary in spreadsheet form.
- The request is about making the existing report portable, not creating a new analytics surface.

## In-Scope Proposed Behavior

- Add a CSV export action for the existing weekly summary table.
- Ensure the export respects the table's current filters.
- Avoid changing the existing dashboard layout while the release is in QA.

## Explicit Non-Goals

- Do not build a full analytics product.
- Do not add richer charts.
- Do not add scheduled reports or email delivery.
- Do not add data warehouse or other external integrations.

## Examples and Acceptance Criteria

- Given an admin has filtered the weekly summary table, when they export CSV, then the CSV represents the filtered table data.

## Edge Cases and Failure Modes

- CSV contents for hidden columns are unresolved and should not be assumed.

## Affected Areas and Integration Points

- Existing dashboard weekly summary table.
- Existing table filtering behavior.

## Testing Expectations

- Cover CSV export from the weekly summary table.
- Cover filtered export behavior.
- Avoid broad analytics dashboard tests unrelated to this slice.

## Documentation / Migration / Rollout Notes

- Note the CSV export in user-facing release notes if this dashboard has release notes.
- No migration is implied by the conversation.

## Assumptions and Open Questions

- Open question: Should CSV include hidden columns?
- Assumption: Existing weekly summary data and filters are already available to the dashboard.

## Conversation Context Worth Preserving

- Leadership is asking for spreadsheet-form weekly workspace summaries.
- The user explicitly wants the current pass to stay small because an existing release is already in QA.
- The current dashboard layout should remain stable.

## Optional / Future Ideas

- Richer charts.
- Scheduled email reports.
- AI insight summaries.
- Syncing reports to a data warehouse.

## Structured Scope Facts

- Actor: admins.
- Surface: existing dashboard weekly summary table.
- Data/entity: weekly workspace summary rows already shown in the table.
- In-scope behavior: CSV export that respects existing table filters.
- Constraint: keep the current dashboard layout stable during QA.
- Explicit exclusions: full analytics product, new charts, scheduled/email delivery, external integrations.
- Open decision: hidden columns in CSV.
