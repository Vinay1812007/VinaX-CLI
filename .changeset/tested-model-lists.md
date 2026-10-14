---
'@sirimillavinay/vinax': minor
---

Model lists now show only models that answer. NVIDIA's catalog alone has about 80 entries, many of them embeddings, retired or hung, so after `/login` and before `/model` or `/models`, VinaX sends each free chat model a tiny test request (six at a time, 20 seconds each, with a progress line) and lists only the ones that replied — "12 of 31 free NVIDIA models answered." Results are kept for a day (failures for 6 hours) and thrown away when the key changes; `/models test` checks again. The model in use stays listed even when it failed, marked "did not answer the last test", and `/model provider:model` still accepts any model by name.

Logging in no longer hangs on one dead model: the key check gives up after 15 seconds and, for NVIDIA, asks several models at once, so any answer proves the key. If your model did not answer the test, `/login` switches the session to one that did (and `vinax login` tells you which one to set as the default).

A model that timed out or was unavailable is no longer tried first on the next turn: VinaX stays on the model it fell back to for 10 minutes, the notice says so, and the status line shows the model actually answering. A model that sends nothing for 45 seconds (`router.firstTokenTimeoutMs`) now counts as timed out, so a hung endpoint falls back in half the time. Models that failed their last test are skipped in fallback and auto routing unless you chose them.
