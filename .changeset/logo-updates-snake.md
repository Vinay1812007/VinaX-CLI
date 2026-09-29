---
'@sirimillavinay/vinax': minor
---

New tricolor VinaX logo, update notices and a Snake game.

- **New VinaX logo** on the welcome screen: striped saffron, white and green letters with a blue chakra in the "a". The brand assets, README logo, docs logo and favicon use it too.
- **Update notices:** VinaX tells you when a newer release is out (checked at most once a day, off in CI or with `VINAX_NO_UPDATE_CHECK=1`), and shows what's new after you upgrade. New `/update` and `/changelog` commands.
- **`/snake`:** Nokia-style Snake in colour, with speed levels, bonus critters and a saved best score.
- **Fix:** an empty model list (e.g. from a gateway that did not serve NVIDIA yet) is no longer cached for a day, and `/login` reloads the provider's models at once, so NVIDIA models no longer stay "not in catalog" after you add a key.
