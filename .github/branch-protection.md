# Branch protection requirements

Before this project is opened for external contribution, configure branch protection for `main` in GitHub repository settings.

Recommended required checks:

- `Validate workspace` from the CI workflow.
- `Review dependency changes` from the dependency review workflow when GitHub dependency review is available.

These requirements are documented for repository administrators and are not enforced by workflow YAML alone. GitHub branch protection must be configured in repository settings or by an explicit repository-management tool.
