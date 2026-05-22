"""MeetMind 应用级常量。"""

ARCHITECT = "architect"
BACKEND = "backend"
FRONTEND = "frontend"
TESTER = "tester"
PM = "pm"

AGENT_NAMES = [ARCHITECT, BACKEND, FRONTEND, TESTER, PM]

NON_ARCHITECT_AGENTS = [BACKEND, FRONTEND, TESTER, PM]

ROLE_DESCRIPTIONS = {
    ARCHITECT: "架构师 (Architect / Tech Lead)",
    BACKEND: "后端工程师 (Backend Engineer)",
    FRONTEND: "前端工程师 (Frontend Engineer)",
    TESTER: "测试工程师 (QA Engineer)",
    PM: "产品经理 (Product Manager)",
}

# \s 表示任意空白字符 ,* 表示"前面那个东西出现 0 次或多次 ,\代表转义字符 , a-zA-Z_ 表示匹配大小写字母和下划线 ,() 用于捕获分组
# 这个正则表达式的意思是匹配形如 [NEXT_AGENT: agent_name] 的字符串，其中 agent_name 可以由大小写字母和下划线组成，且前后可以有任意数量的空白字符。
# 作用是从文本中提取出指定的下一个 agent 的名称，以便进行后续的路由决策。
NEXT_AGENT_PATTERN = r"\[NEXT_AGENT:\s*([a-zA-Z_]+)\]"
DONE_MARKER = "[DONE]"
