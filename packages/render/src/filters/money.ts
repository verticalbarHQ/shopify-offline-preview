/** Liquid inputs are already hundredths; templates come directly from snapshot.shop. */
export function formatMoney(
  input: unknown,
  template: string,
  withoutCurrency = false,
  withoutTrailingZeros = false,
): string {
  const value = typeof input === "number" ? input : Number(input ?? 0);
  if (!Number.isSafeInteger(value))
    throw new Error("Money filter requires a safe integer in Liquid hundredths");
  const formats: Record<string, { digits: number; group: string; decimal: string }> = {
    amount: { digits: 2, group: ",", decimal: "." },
    amount_no_decimals: { digits: 0, group: ",", decimal: "." },
    amount_with_comma_separator: { digits: 2, group: ".", decimal: "," },
    amount_no_decimals_with_comma_separator: { digits: 0, group: ".", decimal: "," },
    amount_with_apostrophe_separator: { digits: 2, group: "'", decimal: "." },
    amount_with_space_separator: { digits: 2, group: " ", decimal: "," },
    amount_no_decimals_with_space_separator: { digits: 0, group: " ", decimal: "," },
    amount_with_period_and_space_separator: { digits: 2, group: " ", decimal: "." },
  };
  let bare: string | undefined;
  const result = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const format = formats[name];
    if (!format) throw new Error(`Unsupported money format: ${name}`);
    const negative = value < 0;
    let magnitude = BigInt(negative ? -value : value);
    if (format.digits === 0) magnitude = (magnitude + 50n) / 100n;
    let whole = (format.digits ? magnitude / 100n : magnitude)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, format.group);
    if (negative) whole = `-${whole}`;
    const fraction = format.digits
      ? `${format.decimal}${(magnitude % 100n).toString().padStart(2, "0")}`
      : "";
    const output = whole + (withoutTrailingZeros && fraction.endsWith("00") ? "" : fraction);
    bare = output;
    return output;
  });
  if (bare === undefined) throw new Error("Money format has no amount placeholder");
  return withoutCurrency ? bare : result;
}
