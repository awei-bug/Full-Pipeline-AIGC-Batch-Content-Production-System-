import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function hasCrc32Builtin() {
  return typeof zlib.crc32 === "function";
}

function computeCrc32(buffer) {
  return hasCrc32Builtin() ? zlib.crc32(buffer) >>> 0 : crc32(buffer);
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
    return this;
  }

  u16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value, 0);
    return this.push(buffer);
  }

  u32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    return this.push(buffer);
  }

  raw(buffer) {
    return this.push(Buffer.from(buffer));
  }

  concat() {
    return Buffer.concat(this.chunks, this.length);
  }
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;

export function createZipWriter() {
  const entries = [];
  const writer = new ByteWriter();
  const now = new Date();
  const { time, day } = dosDateTime(now);

  return {
    addFile(name, content) {
      const nameBuffer = Buffer.from(name, "utf8");
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      const crc = computeCrc32(data);
      const offset = writer.length;

      writer.u32(LOCAL_HEADER_SIGNATURE);
      writer.u16(20);
      writer.u16(UTF8_FLAG);
      writer.u16(0);
      writer.u16(time);
      writer.u16(day);
      writer.u32(crc);
      writer.u32(data.length);
      writer.u32(data.length);
      writer.u16(nameBuffer.length);
      writer.u16(0);
      writer.raw(nameBuffer);
      writer.raw(data);

      entries.push({ nameBuffer, crc, size: data.length, offset });
    },

    toBuffer() {
      const centralOffset = writer.length;
      const central = new ByteWriter();

      for (const entry of entries) {
        central.u32(CENTRAL_HEADER_SIGNATURE);
        central.u16(20);
        central.u16(20);
        central.u16(UTF8_FLAG);
        central.u16(0);
        central.u16(time);
        central.u16(day);
        central.u32(entry.crc);
        central.u32(entry.size);
        central.u32(entry.size);
        central.u16(entry.nameBuffer.length);
        central.u16(0);
        central.u16(0);
        central.u16(0);
        central.u16(0);
        central.u32(0);
        central.u32(entry.offset);
        central.raw(entry.nameBuffer);
      }

      const centralBuffer = central.concat();
      writer.raw(centralBuffer);

      writer.u32(END_OF_CENTRAL_SIGNATURE);
      writer.u16(0);
      writer.u16(0);
      writer.u16(entries.length);
      writer.u16(entries.length);
      writer.u32(centralBuffer.length);
      writer.u32(centralOffset);
      writer.u16(0);

      return writer.concat();
    },

    get entryCount() {
      return entries.length;
    },
  };
}
