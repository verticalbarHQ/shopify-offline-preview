/** SVG placeholder served for a snapshot image whose file is missing (SPEC §7.4.8). */
export function missingImageSvg(width?: number, height?: number): string {
  const size = (value: number) => Math.min(8192, Math.max(1, Math.round(value) || 64));
  return `<svg xmlns="http://www.w3.org/2000/svg" ${width === undefined ? "" : `width="${size(width)}"`} ${height === undefined ? "" : `height="${size(height)}"`} viewBox="0 0 64 64"><rect width="64" height="64" fill="#e2e8f0"/><path d="M12 46l14-16 10 9 7-7 9 14z" fill="#94a3b8"/><circle cx="44" cy="20" r="6" fill="#94a3b8"/></svg>`;
}
