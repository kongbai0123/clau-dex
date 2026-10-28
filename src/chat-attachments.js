import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const MAX_CHAT_IMAGES = 8;
export const MAX_CHAT_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

export function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function normalizeAttachmentMetadata(values = []) {
  if (!Array.isArray(values) || values.length > MAX_CHAT_IMAGES) throw new Error("每則訊息最多附加 8 張圖片。");
  let total = 0;
  const seen = new Set();
  return values.map(value => {
    if (!value || typeof value.id !== "string" || !UUID.test(value.id) || seen.has(value.id)
      || typeof value.name !== "string" || !value.name.trim() || value.name.length > 240
      || !Object.hasOwn(EXTENSIONS, value.mimeType) || typeof value.path !== "string" || !path.isAbsolute(value.path)
      || !Number.isInteger(value.size) || value.size < 1 || value.size > MAX_CHAT_IMAGE_BYTES) throw new Error("無效的圖片附件。");
    seen.add(value.id); total += value.size;
    if (total > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error("圖片附件合計不可超過 20 MiB。");
    return { id: value.id, name: value.name, mimeType: value.mimeType, path: value.path, size: value.size };
  });
}

export function attachmentPreview(value) { return { ...value, previewUrl: `bridge-image://${value.id}` }; }

/** A UUID-only cache. Renderer paths never become filesystem targets. */
export function createChatAttachments(dataDirectory) {
  const directory = path.join(path.resolve(dataDirectory), "attachments");
  mkdirSync(directory, { recursive: true });
  const actualDirectory = realpathSync(directory);
  const baseRelative = path.relative(realpathSync(path.resolve(dataDirectory)), actualDirectory);
  if (!baseRelative || baseRelative.startsWith("..") || path.isAbsolute(baseRelative)) throw new Error("圖片快取不可連結到受管資料夾以外。");
  function contained(file) {
    const relative = path.relative(directory, path.resolve(file));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("圖片路徑超出受管快取。");
    if (existsSync(file)) {
      const actualRelative = path.relative(actualDirectory, realpathSync(file));
      if (!actualRelative || actualRelative.startsWith("..") || path.isAbsolute(actualRelative) || lstatSync(file).isSymbolicLink()) throw new Error("圖片快取不可使用外部連結。");
    }
    return file;
  }
  function filePath(id, extension) {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("無效的圖片識別碼。");
    return contained(path.join(directory, `${id}${extension}`));
  }
  function resolve(id) {
    const metadata = JSON.parse(readFileSync(filePath(id, ".json"), "utf8"));
    if (metadata.id !== id || !Object.hasOwn(EXTENSIONS, metadata.mimeType)) throw new Error("找不到有效的圖片附件。");
    const file = filePath(id, EXTENSIONS[metadata.mimeType]);
    const size = statSync(file).size;
    if (size !== metadata.size || size > MAX_CHAT_IMAGE_BYTES || imageMime(readFileSync(file)) !== metadata.mimeType) throw new Error("圖片附件已變更或損壞，請重新加入。");
    return attachmentPreview(normalizeAttachmentMetadata([{ ...metadata, path: file, size }])[0]);
  }
  function resolveMany(ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_CHAT_IMAGES) throw new Error("每則訊息最多附加 8 張圖片。");
    const values = ids.map(resolve);
    return normalizeAttachmentMetadata(values).map(attachmentPreview);
  }
  function importImages({ images } = {}) {
    if (!Array.isArray(images) || !images.length || images.length > MAX_CHAT_IMAGES) throw new Error("請選擇 1 到 8 張圖片。");
    let total = 0;
    const decoded = images.map(image => {
      if (!image || !Object.hasOwn(EXTENSIONS, image.mimeType) || typeof image.dataUrl !== "string"
        || image.dataUrl.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 100) throw new Error("僅支援 PNG、JPEG、WebP 圖片，每張最多 7 MiB。");
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
      if (!match || match[1] !== image.mimeType) throw new Error("圖片 MIME 與內容不一致。");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")
        || !bytes.length || bytes.length > MAX_CHAT_IMAGE_BYTES || imageMime(bytes) !== image.mimeType) throw new Error("圖片格式無效，或內容與 MIME 不一致。");
      total += bytes.length;
      if (total > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error("圖片附件合計不可超過 20 MiB。");
      const name = typeof image.name === "string" ? image.name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 240).trim() : "";
      return { bytes, name: name || `圖片${EXTENSIONS[image.mimeType]}`, mimeType: image.mimeType };
    });
    const written = [];
    try {
      return decoded.map(({ bytes, name, mimeType }) => {
        const id = randomUUID();
        const file = filePath(id, EXTENSIONS[mimeType]);
        const metadataFile = filePath(id, ".json");
        const metadata = { id, name, mimeType, size: bytes.length };
        writeFileSync(file, bytes, { flag: "wx" }); written.push(file);
        writeFileSync(metadataFile, JSON.stringify(metadata), { flag: "wx" }); written.push(metadataFile);
        return attachmentPreview({ ...metadata, path: file });
      });
    } catch (error) {
      for (const file of written) if (existsSync(contained(file))) unlinkSync(file);
      throw error;
    }
  }
  function remove(ids) {
    for (const id of new Set(ids)) {
      // Only these explicit UUID files can be removed; no recursive deletion.
      for (const extension of [".json", ...Object.values(EXTENSIONS)]) {
        const file = filePath(id, extension);
        if (existsSync(file)) unlinkSync(file);
      }
    }
  }
  return { importImages, resolve, resolveMany, remove, directory };
}
