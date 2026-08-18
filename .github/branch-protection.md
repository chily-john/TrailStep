# Branch protection requirements

Before this project is opened for external contribution, protect `main` in GitHub repository settings or with repository rulesets.

Recommended `main` requirements:

- Require pull requests before merging.
- Require at least one approving review.
- Require review from Code Owners.
- Dismiss stale approvals when new commits are pushed.
- Require conversation resolution before merging.
- Require `Validate workspace` from the CI workflow.
- Require `Review dependency changes` once dependency review is configured as an enforced gate.
- Block force pushes.
- Block branch deletion.

Maintainers should keep release authority separate from general contribution access. New collaborators should normally start with issue triage or scoped code review before receiving broad write or maintain permissions.

These requirements are documented for repository administrators and are not enforced by workflow YAML alone. GitHub branch protection must be configured in repository settings or by an explicit repository-management tool.
