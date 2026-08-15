// WMB-5237: PNG 像素尺寸解析（IHDR），纯字节解析，不依赖 sharp。
// 供 stageAssetBytes / materializeCropAsset 复用；非 PNG 或字节不足返回 null。

export function pngDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24) return null;
  const signature = bytes.subarray(0, 8);
  if (![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => signature[index] === byte)) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
