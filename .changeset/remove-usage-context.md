---
'@sirimillavinay/vinax': minor
---

Usage and context reporting are gone. `/usage`, `/context`, cost estimates (the `pricing` setting, the `cost` field in `--output-format json`, the Cost row on exit), the Tokens row in the exit summary, and per-task token and time budgets (`--token-budget`, `--time-budget`, the `budget` setting) are removed. VinaX no longer writes daily usage files to `~/.vinax/usage`. The status line no longer shows a context percentage and VinaX no longer warns before auto-compaction; compaction still happens on its own (and with `/compact`), with one short notice when it does. Old `budget`, `pricing` and `providers.<name>.rpm` settings are ignored with an "Unknown setting" warning.

NVIDIA usage is unlimited on VinaX's side. The local requests-per-minute limiter (`providers.<name>.rpm`) is removed for every provider. When NVIDIA answers 429, VinaX waits on the same model — as long as `Retry-After` says, otherwise backing off up to 30 seconds — and retries until it answers or you press Esc, instead of skipping it or falling back to another model. The status line shows "waiting for the NVIDIA rate limit — retrying in …". These waits do not use up `router.maxRetries`.

The self-hosted gateway no longer limits requests per token (`RATE_LIMIT_RPM` / `RATE_LIMIT_RPD` are gone); providers' own 429s are still passed through.
