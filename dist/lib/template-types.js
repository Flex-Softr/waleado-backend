"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEMPLATE_TYPE_IDS = void 0;
exports.isTemplateTypeId = isTemplateTypeId;
/** Mirrors `TEMPLATE_TYPE_OPTIONS` ids in the web app. */
exports.TEMPLATE_TYPE_IDS = [
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
];
function isTemplateTypeId(id) {
    return exports.TEMPLATE_TYPE_IDS.includes(id);
}
