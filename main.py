"""项目根目录的启动入口。

直接运行:
    uv run python main.py

或安装后使用 console script:
    uv sync
    uv run meetmind
"""

from meetmind.cli.main import main


if __name__ == "__main__":
    main()
