export type AdminResponseMeta = {
  /** True when the primary datasets for this screen are empty (API still returns 200). */
  noData: boolean;
  /** Human-readable explanation when noData is true */
  message: string | null;
};

export function adminResponseMeta(
  noData: boolean,
  messageWhenEmpty?: string | null
): AdminResponseMeta {
  return {
    noData,
    message: noData
      ? (messageWhenEmpty ??
        "Nothing to show in this view yet. Data will appear as you use the product.")
      : null,
  };
}
