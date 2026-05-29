/**
 * 按文件类型选择文本切块策略。
 *
 * loaders 负责"按文件结构"切（PDF 每页 / DOCX 每段 / MD 整体），
 * 本模块在 loader 输出之上再过一道"按长度"切。
 */

import {
  MarkdownTextSplitter,
  RecursiveCharacterTextSplitter,
} from "@langchain/textsplitters";

import { getLogger } from "../utils/logger.js";
import type { RawDoc } from "./loaders.js";

const logger = getLogger("database.splitters");

interface SplitParams {
  chunkSize: number;
  chunkOverlap: number;
}

const PARAMS: Record<string, SplitParams> = {
  pdf: { chunkSize: 600, chunkOverlap: 80 },
  docx: { chunkSize: 500, chunkOverlap: 60 },
  txt: { chunkSize: 500, chunkOverlap: 60 },
  markdown: { chunkSize: 500, chunkOverlap: 60 },
};

function makeRecursive(params: SplitParams): RecursiveCharacterTextSplitter {
  return new RecursiveCharacterTextSplitter({
    chunkSize: params.chunkSize,
    chunkOverlap: params.chunkOverlap,
    separators: ["\n\n", "\n", "。", "！", "？", ".", "!", "?", " ", ""],
    keepSeparator: false,
  });
}

// ---------- 各类型 splitter ----------

export function splitJson(docs: RawDoc[]): RawDoc[] {
  // 种子 JSON 通常是手写短条目，按原样灌入
  return docs;
}

export async function splitMarkdown(docs: RawDoc[]): Promise<RawDoc[]> {
  // langchain.js 的 MarkdownTextSplitter 已经内置了按 #/##/### 切的策略
  // 之后再用 Recursive 限长
  const headerSplitter = new MarkdownTextSplitter({
    chunkSize: PARAMS.markdown.chunkSize,
    chunkOverlap: PARAMS.markdown.chunkOverlap,
  });

  const out: RawDoc[] = [];
  for (const d of docs) {
    const content = typeof d.content === "string" ? d.content : "";
    if (!content.trim()) {
      continue;
    }
    const pieces = await headerSplitter.splitText(content);
    for (const piece of pieces) {
      const next: RawDoc = { ...d, content: piece };
      out.push(next);
    }
  }
  return out;
}

export async function splitPdf(docs: RawDoc[]): Promise<RawDoc[]> {
  return splitWithRecursive(docs, PARAMS.pdf);
}

export async function splitDocx(docs: RawDoc[]): Promise<RawDoc[]> {
  return splitWithRecursive(docs, PARAMS.docx);
}

export async function splitText(docs: RawDoc[]): Promise<RawDoc[]> {
  return splitWithRecursive(docs, PARAMS.txt);
}

async function splitWithRecursive(
  docs: RawDoc[],
  params: SplitParams,
): Promise<RawDoc[]> {
  const splitter = makeRecursive(params);
  const out: RawDoc[] = [];
  for (const d of docs) {
    const content = typeof d.content === "string" ? d.content : "";
    if (!content.trim()) {
      continue;
    }
    const pieces = await splitter.splitText(content);
    if (pieces.length <= 1) {
      out.push(d);
      continue;
    }
    for (let i = 0; i < pieces.length; i++) {
      const newDoc: RawDoc = { ...d, content: pieces[i] };
      const base = typeof d.source === "string" ? d.source : "";
      newDoc.source = base ? `${base}#chunk${i}` : `chunk${i}`;
      out.push(newDoc);
    }
  }
  return out;
}

// ---------- 顶层分发 ----------

type DispatchFn = (docs: RawDoc[]) => Promise<RawDoc[]> | RawDoc[];

const DISPATCH: Record<string, DispatchFn> = {
  json: splitJson,
  markdown: splitMarkdown,
  md: splitMarkdown,
  pdf: splitPdf,
  docx: splitDocx,
  txt: splitText,
  text: splitText,
};

/**
 * 根据每条 doc 的 `type` 字段分发到对应 splitter，未知类型走 splitText 兜底。
 */
export async function splitDocs(docs: RawDoc[]): Promise<RawDoc[]> {
  if (docs.length === 0) {
    return [];
  }

  // 按 type 分组
  const byType = new Map<string, RawDoc[]>();
  for (const d of docs) {
    const rawType = typeof d.type === "string" ? d.type : "text";
    const t = rawType.toLowerCase();
    let bucket = byType.get(t);
    if (bucket === undefined) {
      bucket = [];
      byType.set(t, bucket);
    }
    bucket.push(d);
  }

  const out: RawDoc[] = [];
  for (const [t, group] of byType.entries()) {
    const fn = DISPATCH[t] ?? splitText;
    const chunks = await fn(group);
    if (chunks.length !== group.length) {
      logger.info(`[splitter] type=${t} 原始 ${group.length} 段 → 切块 ${chunks.length} 段`);
    }
    out.push(...chunks);
  }
  return out;
}
