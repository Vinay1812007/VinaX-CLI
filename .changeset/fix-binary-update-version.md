---
'@sirimillavinay/vinax': patch
---

Fix standalone updates reporting success after downloading an older binary. Verify the downloaded executable's version before replacing the installed CLI, and build GitHub releases using the triggering commit's version with a binary version check before upload.
