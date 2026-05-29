/**
 * 文档加载器：把 JSON / Markdown / PDF / Word / 纯文本 文件统一解析为 RAG 文档列表。
 *
 * 每种文件格式对应一个独立函数，输入是文件绝对路径，输出是 RawDoc[]。
 * 顶层 `loadFile()` 根据扩展名分发。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { getLogger } from "../utils/logger.js";

const logger = getLogger("database.loaders");

export interface RawDoc {
  content: string;
  type?: string;
  date?: string;
  source?: string;
  // 允许 loader 写入额外字段（如 markdown 的 h1/h2 元信息），后续 splitter 会保留
  [extra: string]: unknown;
}

// ---------- JSON ----------

export async function loadJson(filePath: string): Promise<RawDoc[]> {
  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (exc) {
    logger.warning(`JSON ${filePath} 解析失败：${String(exc)}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warning(`JSON ${filePath} 顶层不是数组，已跳过`);
    return [];
  }
  const docs: RawDoc[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.content !== "string") {
      continue;
    }
    const doc: RawDoc = { content: obj.content };
    for (const [k, v] of Object.entries(obj)) {
      if (k === "content") {
        continue;
      }
      doc[k] = v;
    }
    if (doc.type === undefined) {
      doc.type = "json";
    }
    if (doc.source === undefined) {
      doc.source = path.basename(filePath);
    }
    docs.push(doc);
  }
  return docs;
}

// ---------- Markdown ----------

export async function loadMarkdown(filePath: string): Promise<RawDoc[]> {
  const text = await readFile(filePath, "utf-8");
  const baseName = path.basename(filePath);

  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let hasHeading = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      hasHeading = true;
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n").trim());
  }

  if (!hasHeading) {
    // 退化为按空行分段
    const newBlocks: string[] = [];
    for (const b of text.split("\n\n")) {
      const trimmed = b.trim();
      if (trimmed) {
        newBlocks.push(trimmed);
      }
    }
    blocks.splice(0, blocks.length, ...newBlocks);
  }

  const result: RawDoc[] = [];
  for (const b of blocks) {
    const stripped = b.trim();
    if (stripped) {
      result.push({ content: stripped, type: "markdown", source: baseName });
    }
  }
  return result;
}

// ---------- PDF ----------

export async function loadPdf(filePath: string): Promise<RawDoc[]> {
  // pdfjs-dist 4.x 默认入口就是 build/pdf.mjs（ESM）
  const pdfjs = await import("pdfjs-dist");
  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = pdfjs.getDocument({
    data,
    // Node 没有 worker；显式关掉避免报错
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const pdf = await loadingTask.promise;

  const baseName = path.basename(filePath);
  const docs: RawDoc[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const parts: string[] = [];
    for (const item of tc.items) {
      // pdfjs-dist 的 item 既可能是 TextItem 也可能是 TextMarkedContent；只关心前者
      const maybe = item as { str?: string };
      if (typeof maybe.str === "string" && maybe.str.length > 0) {
        parts.push(maybe.str);
      }
    }
    const text = parts.join(" ").trim();
    if (!text) {
      continue;
    }
    docs.push({
      content: text,
      type: "pdf",
      source: `${baseName}#page${i}`,
    });
  }
  return docs;
}

// ---------- DOCX ----------

export async function loadDocx(filePath: string): Promise<RawDoc[]> {
  const mammoth = await import("mammoth");
  const buffer = await readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const baseName = path.basename(filePath);

  // mammoth 输出按段落用 `\n` 分隔；过滤空段对齐 python-docx 的 doc.paragraphs 行为
  const docs: RawDoc[] = [];
  for (const para of result.value.split(/\r?\n/)) {
    const text = para.trim();
    if (!text) {
      continue;
    }
    docs.push({ content: text, type: "docx", source: baseName });
  }
  return docs;
}

// ---------- 纯文本 ----------

export async function loadText(filePath: string): Promise<RawDoc[]> {
  const text = await readFile(filePath, "utf-8");
  const baseName = path.basename(filePath);
  const result: RawDoc[] = [];
  for (const raw of text.split("\n\n")) {
    const stripped = raw.trim();
    if (stripped) {
      result.push({ content: stripped, type: "text", source: baseName });
    }
  }
  return result;
}

// ---------- 分发器 ----------

type LoaderFn = (filePath: string) => Promise<RawDoc[]>;

const LOADERS: Record<string, LoaderFn> = {
  ".json": loadJson,
  ".md": loadMarkdown,
  ".markdown": loadMarkdown,
  ".pdf": loadPdf,
  ".docx": loadDocx,
  ".txt": loadText,
};

/**
 * 根据文件扩展名分发到对应 loader。每个 RawDoc 至少有 `content`。
 */
export async function loadFile(filePath: string): Promise<RawDoc[]> {
  const ext = path.extname(filePath).toLowerCase();
  const loader = LOADERS[ext];
  if (!loader) {
    logger.warning(`不支持的文件类型，跳过：${path.basename(filePath)}`);
    return [];
  }
  try {
    return await loader(filePath);
  } catch (exc) {
    logger.error(`解析 ${filePath} 失败：${String(exc)}`);
    return [];
  }
}
