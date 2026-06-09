# 示例：完整调用链文字版（MeetMind 项目）

这是 skill 的"默认输出样式参考"。用户偏好这种层级缩进 + `(文件路径)` 标注的格式：可扫描、可搜索、不会渲染失败。

---

## 🚀 启动入口

```
python main.py
└─ main.py :: main()                                    ← 根目录入口，只是个壳
   └─ meetmind/cli/main.py :: main()                    ← 真正的 CLI 主函数
```

## 📦 `cli/main.py :: main()` 内部三件事

### ① `_print_banner()` — 打印彩色横幅
没有子调用，就是几行 `console.print(...)`。

### ② `_bootstrap()` — 启动准备（校验 + 灌种子）

```
_bootstrap()                                            (cli/main.py)
├─ setup_logging()                                      (utils/logger.py)         配置 rich 日志器
├─ get_settings()                                       (config/settings.py)      读 .env，单例
├─ 检查 API_KEY/BASE_URL/MODEL_NAME，缺则 sys.exit(1)
├─ 扫描 data/seed/<agent>/ 列出所有种子文件并打印
└─ initialize_all_agents()                              (database/initializer.py)
   └─ 对 5 个 agent 各跑一次 _seed_agent(agent_name)
      ├─ get_agent_collection(agent_name)               (database/client.py)
      │  └─ chromadb.PersistentClient(path=…)           本地 SQLite，每 agent 独立目录
      ├─ _load_agent_seeds(agent_name)                  (database/initializer.py)
      │  └─ 遍历 data/seed/<agent>/ 下每个文件:
      │     └─ load_file(path)                          (database/loaders.py)
      │        └─ 按后缀分发到:
      │           ├─ load_json(path)                    ← .json
      │           ├─ load_markdown(path)                ← .md / .markdown
      │           ├─ load_pdf(path)                     ← .pdf（用 pypdf）
      │           ├─ load_docx(path)                    ← .docx（用 python-docx）
      │           └─ load_text(path)                    ← .txt
      ├─ _doc_id(agent_name, content)                   md5 hash 生成稳定 ID（幂等）
      └─ collection.add(ids, documents, metadatas)      写入 Chroma
```

---

## 关键格式规则总结

1. **每行末尾对齐文件路径** `(path/to/file.py)`
2. **树形字符** `├─ └─ │` 表示层级，不用纯空格
3. **关键参数列在函数名后面**：`func(arg1, arg2)`
4. **一句话职责紧跟在路径后**：`├─ func()  (path/file.py)    简短说明`
5. **大段分章节用 `## 标题`**，每个章节单独画一棵小树
6. **循环 / 分支**用伪代码块表达：

   ```
   for _ in range(MAX_RETRY):
      ├─ try_once()
      └─ if success: break
   ```

7. **外部库调用不展开**：`requests.get(url)` 就到此为止，不进入 requests 内部
8. **末尾给一句话总结**，让用户一眼看到主干：

   ```
   一句话总结：main → bootstrap (灌库) → build_graph → loop (跑一轮 + 复盘)
   ```
