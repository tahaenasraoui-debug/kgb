/** NDS/GBA CRC-16 (reflected poly 0xA001, init 0xFFFF). */
export function crc16(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffff;
  const stop = Math.min(end, data.length);
  for (let i = start; i < stop; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}
