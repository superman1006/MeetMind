import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureAgentTable, getPgPool } from "../connection/client.js";
import { embedBatch } from "../models/embedding.js";
import { loadFile } from "./loaders.js";
import { splitDocs } from "./splitters.js";

const FILE_LIMIT = 10 * 1024 * 1024;
const supportedExtensions = new Set([".txt", ".md", ".markdown", ".json", ".pdf", ".docx"]);

// 把上传内容解析、切块并批量向量化，写入所选 agent_key 对应的知识表。
export async function uploadTwinKnowledge(agentKey: string, filename: string, base64: string): Promise<number> {
  const extension = path.extname(filename).toLowerCase();
  if (!supportedExtensions.has(extension) || /[/\\\x00-\x1f]/.test(filename)) {
    throw new Error("文件名或格式不支持");
  }
  const content = Buffer.from(base64, "base64");
  if (!content.length || content.length > FILE_LIMIT || content.toString("base64") !== base64) {
    throw new Error("文件内容无效或超过 10 MiB");
  }

  const directory = await mkdtemp(path.join(tmpdir(), "meetmind-knowledge-"));
  try {
    // 临时文件保留原扩展名，供已有加载器按格式解析。外层 finally 负责清理。
    const temporaryFile = path.join(directory, `upload${extension}`);
    await writeFile(temporaryFile, content);
    const documents = await loadFile(temporaryFile);
    const chunks = await splitDocs(documents);
    const texts: string[] = [];
    for (const chunk of chunks) {
      const text = chunk.content.trim();
      if (text) texts.push(text);
    }
    if (!texts.length) throw new Error("文件没有可检索的文本，或解析失败");

    const vectors = await embedBatch(texts);
    const table = await ensureAgentTable(agentKey);
    const client = await getPgPool().connect();
    let count = 0;
    try {
      await client.query("BEGIN");
      const metadata = JSON.stringify({ source: filename, type: extension.slice(1) });
      for (let i = 0; i < texts.length; i += 1) {
        // 用文件名和片段正文生成稳定主键，重复上传相同片段时复用已有记录。
        const hash = createHash("sha256");
        hash.update(filename);
        hash.update("\0");
        hash.update(texts[i]);
        const docId = hash.digest("hex");
        const vector = `[${vectors[i].join(",")}]`;
        const result = await client.query(`INSERT INTO ${table} (id, content, metadata, embedding)
          VALUES ($1,$2,$3,$4::vector) ON CONFLICT (id) DO NOTHING`, [docId, texts[i], metadata, vector]);
        count += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return count;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function listTwinKnowledge(agentKey: string): Promise<Array<{ filename: string; chunks: number }>> {
  const table = await ensureAgentTable(agentKey);
  const result = await getPgPool().query(`SELECT coalesce(metadata->>'source','种子知识') AS filename,
    count(*)::int AS chunks FROM ${table} GROUP BY 1 ORDER BY 1`);
  return result.rows;
}
