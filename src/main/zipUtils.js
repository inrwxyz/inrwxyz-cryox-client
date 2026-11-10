const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Pure Node.js ZIP reader & safe extractor (supports STORE and DEFLATE entries).
 * Strictly enforces path traversal prevention and never executes extracted files.
 */
function parseZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Invalid or corrupted ZIP archive buffer.');
  }

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ZIP End of Central Directory signature not found.');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > buffer.length) {
    throw new Error('ZIP Central Directory exceeds buffer bounds.');
  }

  const entries = [];
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > buffer.length || buffer.readUInt32LE(ptr) !== 0x02014b50) {
      break;
    }
    const compressionMethod = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const fileNameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);

    const rawName = buffer.subarray(ptr + 46, ptr + 46 + fileNameLen).toString('utf8');
    const normalizedName = rawName.replace(/\\/g, '/');

    entries.push({
      name: normalizedName,
      isDirectory: normalizedName.endsWith('/'),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      extractBuffer() {
        if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
          throw new Error(`Invalid local file header for entry: ${normalizedName}`);
        }
        const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > buffer.length) {
          throw new Error(`Entry data out of bounds: ${normalizedName}`);
        }
        const slice = buffer.subarray(dataStart, dataEnd);
        if (compressionMethod === 0) {
          return Buffer.from(slice);
        }
        if (compressionMethod === 8) {
          return zlib.inflateRawSync(slice);
        }
        throw new Error(`Unsupported ZIP compression method (${compressionMethod}) in ${normalizedName}`);
      }
    });

    ptr += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

function validateSafeRelativePath(relPath, targetRootDir) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('Unsafe empty archive path');
  }
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleanRel.includes('\0') || cleanRel.split('/').includes('..') || path.isAbsolute(cleanRel)) {
    throw new Error(`Blocked unsafe path traversal attempt: ${relPath}`);
  }
  const resolvedRoot = path.resolve(targetRootDir);
  const resolvedTarget = path.resolve(resolvedRoot, cleanRel);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Blocked path outside target directory: ${relPath}`);
  }
  return resolvedTarget;
}

function extractZipFiltered(zipFilePath, targetRootDir, filterFn) {
  const buf = fs.readFileSync(zipFilePath);
  const entries = parseZipBuffer(buf);
  const extractedFiles = [];

  fs.mkdirSync(targetRootDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const mappedRelative = filterFn ? filterFn(entry.name) : entry.name;
    if (!mappedRelative) continue;

    const safeDest = validateSafeRelativePath(mappedRelative, targetRootDir);
    fs.mkdirSync(path.dirname(safeDest), { recursive: true });
    const data = entry.extractBuffer();
    fs.writeFileSync(safeDest, data);
    extractedFiles.push(safeDest);
  }

  return extractedFiles;
}


const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZipBuffer(filesMap) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const entries = Object.entries(filesMap);

  for (const [rawName, content] of entries) {
    const nameBuf = Buffer.from(String(rawName).replace(/\\/g, '/'), 'utf8');
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const crc = crc32Buffer(dataBuf);
    const size = dataBuf.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

module.exports = {
  createStoredZipBuffer,
  parseZipBuffer,
  validateSafeRelativePath,
  extractZipFiltered
};
