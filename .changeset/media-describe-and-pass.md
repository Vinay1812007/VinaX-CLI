---
'@sirimillavinay/vinax': minor
---

Images and screen recordings now work with any model. Your model stays in charge of the turn: when it can't see an image (gpt-oss and most defaults are text-only), a vision model reads it together with your request and a recap of the conversation, transcribes every visible line of code, error and terminal output, describes the layout, and hands that description to your model, which carries on with its own tools — "Reading [Image #1] with nvidia:… (gpt-oss-20b can't see images)." Before, the whole turn moved to the vision model and later turns only got a note that an image had existed. Descriptions are saved with the session (so `/resume` and compaction keep them) and each image is described once; models that can see still get the image itself.

Screen recordings (MP4, MOV, M4V, WebM, MKV, AVI) can be dragged in, pasted as paths or mentioned with `@` and show as `[Video #1]`. Models marked as taking video (NVIDIA's Nemotron omni and Cosmos reasoning models) get recordings up to 50 MB whole; otherwise VinaX samples up to 12 frames with ffmpeg and a vision model describes them in order with timestamps. Without ffmpeg, a warning says how to install it.

The Read tool now accepts images and recordings and returns a description written for the current task. `@` mentions that can't be attached (binaries, text over 2 MB) produce a warning instead of being dropped silently. OpenAI's gpt-4o, gpt-4.1, gpt-5 and o-series models, Claude, Gemini, Llama 4, Gemma 3, Pixtral and Qwen VL now count as able to see images even when the provider's catalog doesn't say.
