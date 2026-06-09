---
name: project-flow-analyzer
description: 分析项目代码的调用链并可视化。当用户要求 "分析项目流程 / 调用链 / 调用关系"、"从 main 开始展开"、"画项目结构图 / 架构图 / 流程图 / 调用图"、"展示函数调用"、"可视化项目"、"什么调用了什么" 等场景时使用。从入口函数开始递归展开调用，逐层记录文件路径、函数名、关键参数和一句话职责。**默认输出层级缩进的文字版调用链**（可扫描、不会渲染失败）；只有当用户明确说"画图 / HTML / mermaid / 可视化"时才生成 HTML 图。
---

# Project Flow Analyzer

## 1. 何时触发本 skill

用户的请求满足以下任一意图时使用：

- 分析项目调用流程、调用链、调用关系
- 从入口（main / cli / entrypoint）开始展开看"谁调用了谁"
- 画项目结构图、架构图、流程图、调用图
- 可视化项目、展示模块/函数关系

如果用户的话只是要"看代码"或"读文件"——不是要看**关系/调用链**——不要触发本 skill。

## 2. 工作流

### Step 1: 找入口

按项目类型确定入口文件 + 入口函数：

| 项目类型 | 常见入口 |
|---------|---------|
| Python (CLI) | `main.py`、`__main__.py`、`<pkg>/cli/main.py`、`pyproject.toml` 的 `[project.scripts]` |
| Python (lib) | 用户指定的目标函数，或 `__init__.py` 暴露的主接口 |
| Python (Web) | `app.py`、`wsgi.py`、`manage.py`，框架的 `create_app()` |
| Node | `package.json` 的 `main` / `bin`、`index.js` |
| Go | `main.go` 的 `func main()` |
| Rust | `src/main.rs` 的 `fn main()` |
| Java | 含 `public static void main` 的类 |

如果用户没指定，**先 grep 确认**，不要凭名字猜。

### Step 2: 递归展开调用

从入口函数开始，逐层展开它调用的函数 / 类 / 方法。对每个被调用的对象记录：

- **文件路径**（相对项目根，例如 `meetmind/agents/base.py`）
- **函数/方法名**（如 `BaseAgent.process`）
- **关键参数**（只列必要的，类型可选）
- **一句话职责**

**展开规则**：
- 项目自身的函数 → 展开
- 标准库 / 第三方库 → 标注一下用了什么就停（例如 `requests.get(url)`、`json.loads(text)` 不再展开内部）
- 工厂函数 / 一行 wrapper → 跳过中间层，直接展开它的产物
- 控制流（`while True:`、`for ... in ...`）→ 用箭头或 `[/伪代码/]` 表示，不要漏掉

**禁止凭训练数据猜**：每条 `(path/to/file.py)` 都必须是用 Read 或 Grep 实际验证过的真实路径。

### Step 3: 输出

**默认输出 = 层级缩进的文字版调用链**。用户绝大多数情况只要这个：

```
入口
├─ 第一层函数A()                                    (path/to/file.py)
│  ├─ 第二层函数B(arg1, arg2)                       (path/to/another.py)
│  │  └─ 第三层函数C()                              (path/to/third.py)
│  └─ 第二层函数D()                                 (path/to/another.py)
└─ 第一层函数E()                                    (path/to/file.py)
```

格式要点：
- 用 `├─ └─ │` 树形字符（不要用纯空格缩进，可读性差）
- 每行末尾对齐 `(文件路径)`
- 控制流用 `【for each x: …】` 或 `【while True:】` 包起来
- 跨章节用 `---` 横线或 emoji 标题（如 `## 🤖 内部循环`）分块

**只在用户明确说 "画图 / HTML / mermaid / 可视化 / 流程图 (要图形版)" 时输出 HTML**：
- 单文件 HTML，CDN 加载 mermaid
- **必须**遵循 `references/mermaid-pitfalls.md` 里的全部规则，否则会渲染失败
- 生成后告诉用户文件路径 + 直接用 `open` 命令打开

## 3. 工具选择

- **Explore agent**（不是 general-purpose）：找入口、grep 调用关系、找类定义。Explore 是只读、专门干这个的。
- **Read**：知道路径后读完整文件
- **Grep**：搜索 `def func_name`、`func_name(`、`import X` 等
- **不要凭训练数据**：每条调用关系都要在代码里确实存在。如果一个函数的实现你猜不出来，就 Read 它再写。

## 4. 写作风格

- 中英文混排：函数名、文件路径用英文；说明用中文
- 一行写完一个 caller→callee 关系，不要拆成多行
- 同层调用之间留空行帮助阅读
- 如果调用链超过 5 层，分章节，每个章节单独画
- 大循环 / 大分支 用伪代码块 `for ... { ... }` 或 `if cond { ... }` 表达

## 5. 完整示例

参考 `references/example-output.md` 看一个完整的层级缩进调用链长什么样。

mermaid 图相关的所有坑见 `references/mermaid-pitfalls.md`，**画图前必读**。
