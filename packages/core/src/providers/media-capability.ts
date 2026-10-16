/**
 * What a model can see when its catalog does not say. OpenAI's `/models` (and most others) list
 * ids only, so without this gpt-4o, gpt-5 or Claude would count as blind. Conservative on
 * purpose: only well-known multimodal families match, and audio/embedding/search variants never.
 */
const NOT_VISION =
  /embed|audio|realtime|transcribe|tts|whisper|search|moderation|dall-e|gpt-image|instant|claude-2|gemma-?3-1b/i;

const VISION_FAMILIES: readonly RegExp[] = [
  /(^|\/)gpt-4o/i,
  /(^|\/)gpt-4\.1/i,
  /(^|\/)gpt-4-turbo/i,
  /(^|\/)gpt-5/i,
  /(^|\/)o1(?!-mini|-preview)(\b|-)/i,
  /(^|\/)o3(?!-mini)(\b|-)/i,
  /(^|\/)o4-mini/i,
  /(^|\/)claude-/i,
  /(^|\/)gemini-/i,
  /vision/i,
  /(^|[/_.-])vl([/_.-]|$)/i,
  /llava/i,
  /pixtral/i,
  /qwen[\d.]*-?vl/i,
  /(^|\/)gemma-?3n?-/i,
  /(^|\/)gemma-?4/i,
  /(^|\/)llama-4/i,
  /multimodal/i,
  /omni/i,
];

/** Whether a model id belongs to a family known to accept images. */
export function inferVision(id: string): boolean {
  if (NOT_VISION.test(id)) return false;
  return VISION_FAMILIES.some((re) => re.test(id));
}

/** Models known to accept `video_url` input (NVIDIA's omni and Cosmos reasoning models). */
const VIDEO_FAMILIES: readonly RegExp[] = [
  /nemotron-\d+-nano-omni/i,
  /cosmos-?\d*-?(nano-)?reason/i,
];

/** Whether a model id belongs to a family known to accept video. */
export function inferVideo(id: string): boolean {
  return VIDEO_FAMILIES.some((re) => re.test(id));
}
