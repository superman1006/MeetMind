"""项目根目录的启动入口。

直接运行:
    uv run python main.py

或安装后使用 console script:
    uv sync
    uv run meetmind
"""

from dotenv import load_dotenv

# LangSmith SDK 从 os.environ 读取追踪开关；pydantic-settings 读 .env 时只填充
# Settings 对象、不写入 os.environ，所以必须在导入任何 LangChain 模块前先手动 load。
load_dotenv()

from meetmind.cli.main import main


if __name__ == "__main__":
    main()
