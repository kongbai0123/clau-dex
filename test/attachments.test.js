import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createChatAttachments, MAX_CHAT_IMAGE_BYTES, normalizeAttachmentMetadata } from "../src/chat-attachments.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-images-"));
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup path");
  rmSync(root, { recursive: true, force: true });
});
const png = { name: "sample.png", mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=" };
function jpeg(size) {
  const bytes = Buffer.alloc(size, 1);
  bytes[0] = 255; bytes[1] = 216; bytes[2] = 255;
  return { name: "photo.jpg", mimeType: "image/jpeg", dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` };
}

test("imports are UUID-owned images with safe previews and persist metadata without base64", () => {
  const store = createChatAttachments(path.join(root, "persist"));
  const [image] = store.importImages({ images: [{ ...png, name: "../../sample.png", path: path.join(root, "outside.png") }] });
  assert.equal(image.name, "sample.png");
  assert.equal(image.previewUrl, `bridge-image://${image.id}`);
  assert.equal(path.dirname(image.path), store.directory);
  assert.equal(image.size, Buffer.from(png.dataUrl.split(",")[1], "base64").length);
  const persisted = readFileSync(path.join(store.directory, `${image.id}.json`), "utf8");
  assert.doesNotMatch(persisted, /base64|dataUrl|outside\.png|previewUrl/);
  assert.deepEqual(createChatAttachments(path.join(root, "persist")).resolve(image.id), image);
  assert.deepEqual(store.resolveMany([image.id]), [image]);
});

test("empty names after trimming whitespace and controls use a resolvable fallback", () => {
  const store = createChatAttachments(path.join(root, "blank-name"));
  const [image] = store.importImages({ images: [{ ...png, name: "  \t\n\u0000  " }] });
  assert.equal(image.name, "圖片.png");
  assert.equal(store.resolve(image.id).name, "圖片.png");
  const [trimmed] = store.importImages({ images: [{ ...png, name: "   photo.png   " }] });
  assert.equal(trimmed.name, "photo.png");
});

test("unsupported formats, MIME mismatches and malformed base64 fail before writing a batch", () => {
  const store = createChatAttachments(path.join(root, "formats"));
  for (const bad of [
    { name: "vector.svg", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    { name: "animation.gif", mimeType: "image/gif", dataUrl: "data:image/gif;base64,R0lGODlh" },
    { ...png, mimeType: "image/jpeg" },
    { ...png, dataUrl: "data:image/png;base64,/9j/AA==" },
    { ...png, dataUrl: "data:image/png;base64,AA=AAA" },
    { name: "path.png", mimeType: "image/png", path: "C:\\arbitrary\\image.png" },
  ]) {
    assert.throws(() => store.importImages({ images: [png, bad] }));
    assert.equal(readdirSync(store.directory).length, 0);
  }
});

test("image limits reject nine images, oversized files and batches above twenty MiB", () => {
  const store = createChatAttachments(path.join(root, "limits"));
  assert.throws(() => store.importImages({ images: Array(9).fill(png) }), /1 到 8/);
  assert.throws(() => store.importImages({ images: [jpeg(MAX_CHAT_IMAGE_BYTES + 1)] }), /7 MiB|格式無效/);
  const maximum = jpeg(MAX_CHAT_IMAGE_BYTES);
  assert.throws(() => store.importImages({ images: [maximum, maximum, maximum] }), /20 MiB/);
  assert.equal(readdirSync(store.directory).length, 0);
});

test("resolution rejects arbitrary IDs, duplicate IDs, tampering and externally supplied metadata paths", () => {
  const store = createChatAttachments(path.join(root, "resolution"));
  const [image] = store.importImages({ images: [png] });
  assert.throws(() => store.resolve("../../settings"), /識別碼/);
  assert.throws(() => store.resolveMany([image.id, image.id]), /無效的圖片/);
  const metadata = path.join(store.directory, `${image.id}.json`);
  writeFileSync(metadata, JSON.stringify({ ...image, path: path.join(root, "outside.png"), secret: "do not retain" }));
  assert.equal(store.resolve(image.id).path, image.path);
  assert.equal(Object.hasOwn(store.resolve(image.id), "secret"), false);
  writeFileSync(image.path, Buffer.from("not an image"));
  assert.throws(() => store.resolve(image.id), /已變更或損壞/);
  assert.throws(() => normalizeAttachmentMetadata([{ ...image, path: "relative.png" }]), /無效的圖片/);
});

test("removal deletes only explicit owned UUID image files and metadata", () => {
  const store = createChatAttachments(path.join(root, "removal"));
  const [first, second] = store.importImages({ images: [png, png] });
  const sentinel = path.join(store.directory, "keep.txt");
  writeFileSync(sentinel, "keep this unrelated file");
  assert.throws(() => store.remove(["../../keep.txt"]), /識別碼/);
  store.remove([first.id]);
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(path.join(store.directory, `${first.id}.json`)), false);
  assert.equal(existsSync(second.path), true);
  assert.equal(readFileSync(sentinel, "utf8"), "keep this unrelated file");
});
