---
'@sirimillavinay/vinax': minor
---

NVIDIA now means NVIDIA's free endpoints only. VinaX lists, tests, routes to and falls back to just the chat models build.nvidia.com marks "Free Endpoint" — Nemotron 3 Super and Ultra, Nemotron 3.5 Super VL and Lightning, GPT-OSS 20B, Muse Glimmer, GLM 5.3 and 5.3 Flash, Laguna XS 2.1, Step 5 Preview, DeepSeek V4.1 Flash, Gemma 4 31B, DiffusionGemma, Nemotron 3 Nano Omni, Cosmos 3 Nano Reasoner and the Llama 3.2 Vision models — and nothing else from NVIDIA's catalog appears in `/model`, `/models`, auto mode, fallbacks or model tests. NVIDIA's exact ids are matched by slug (`glm-5.3` or `glm-5-3`), and VinaX knows which of these models see images and which understand video. The default fallback chain now tries `nvidia:nvidia/nemotron-3-super-120b-a12b` before `nvidia:openai/gpt-oss-20b`.

A reply that breaks off partway — such as NVIDIA's "list index out of range" — no longer ends the turn. VinaX discards the partial reply and asks again: the same model after a short wait, then the same model with VinaX's text tool protocol (which sidesteps the server's tool-call parser), then the next model in the chain. Tool calls only run after a complete reply, so nothing runs twice. In `-p` text mode a `[retrying…]` line marks the break. If every option fails, the error card says the provider failed mid-reply and that VinaX already retried, with the server's message as the detail.

Requests are tidier for strict servers: empty assistant turns are left out, tool results carry the tool's name, and empty or broken tool-call arguments are sent as `{}`.
