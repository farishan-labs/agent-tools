# CI and notification settings

This repository runs CI only on pull requests and pushes to `main` to avoid noisy runs.

## Disable email on failure

GitHub sends email notifications to watchers when a workflow fails. To disable:

1. Go to **GitHub Settings -> Notifications -> Actions** and uncheck email for failed workflows, or
2. In the repository, go to **Settings -> Notifications** and disable Actions failure emails.

Non-blocking steps in the workflow use `continue-on-error: true` so minor issues do not fail CI or trigger notifications.
