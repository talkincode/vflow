// Header metadata only; this does not decode, crop, render or certify visual quality.
export function imageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    String.fromCharCode(...bytes.slice(12, 16)) === "IHDR"
  ) {
    const width = view.getUint32(16),
      height = view.getUint32(20);
    if (width > 0 && height > 0) return { width, height };
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at] !== 255) break;
      const marker = bytes[at + 1];
      at += 2;
      if (marker === 217 || marker === 218) break;
      if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215))
        continue;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        size >= 7
      ) {
        const height = view.getUint16(at + 3),
          width = view.getUint16(at + 5);
        if (width && height) return { width, height };
      }
      at += size;
    }
  }
  return undefined;
}
