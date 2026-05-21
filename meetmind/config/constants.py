"""Application-wide constants for MeetMind."""

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

NEXT_AGENT_PATTERN = r"\[NEXT_AGENT:\s*([a-zA-Z_]+)\]"
DONE_MARKER = "[DONE]"
