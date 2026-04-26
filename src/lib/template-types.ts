/** Mirrors `TEMPLATE_TYPE_OPTIONS` ids in the web app. */
export const TEMPLATE_TYPE_IDS = [
  "text_message",
  "message_image",
  "message_document",
  "message_contact",
  "message_poll",
  "message_buttons",
  "message_list",
  "message_carousel",
  "message_location",
  "message_video",
  "message_audio",
  "cta_button",
  "copy_code",
  "flow_message",
  "mixed_interactive",
] as const;

export type TemplateTypeId = (typeof TEMPLATE_TYPE_IDS)[number];

export function isTemplateTypeId(id: string): id is TemplateTypeId {
  return (TEMPLATE_TYPE_IDS as readonly string[]).includes(id);
}
