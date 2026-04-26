"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminResponseMeta = adminResponseMeta;
function adminResponseMeta(noData, messageWhenEmpty) {
    return {
        noData,
        message: noData
            ? (messageWhenEmpty ??
                "Nothing to show in this view yet. Data will appear as you use the product.")
            : null,
    };
}
