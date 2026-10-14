"""给真的会话进程用的假 SDK 客户端：测试用环境变量 IDEA_LOOM_SESSION_CLIENT 让会话进程加载它，不调模型。

A fake SDK client for a real session process: tests make the process load it through the
IDEA_LOOM_SESSION_CLIENT environment variable; no model is called.

说的话决定它做什么 / what it does depends on the message:
- 带"慢"字：分几步说，每步之间停一下，像一轮要做一阵子的活。 / contains 慢: speaks in steps with pauses, like a turn that takes a while.
- 带"问"字：先去要一次权限（走真的权限回调），再往下说。 / contains 问: asks for a permission first (through the real callback), then goes on.
"""

import asyncio
from types import SimpleNamespace


def kind(name):
    return type(name, (SimpleNamespace,), {})


SystemMessage, AssistantMessage, UserMessage, ResultMessage = kind("SystemMessage"), kind("AssistantMessage"), kind("UserMessage"), kind("ResultMessage")
TextBlock, ToolResultBlock = kind("TextBlock"), kind("ToolResultBlock")


class Client:
    def __init__(self, cwd, mode, resume, can_use_tool, model="", effort=""):
        self.can_use_tool, self.resume, self.queries = can_use_tool, resume, asyncio.Queue()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        await self.queries.put(prompt if isinstance(prompt, str) else "")

    async def receive_messages(self):
        # 和真的一样一直往下给，不按轮停。 / Like the real one, it keeps yielding rather than stopping per turn.
        while True:
            text = await self.queries.get()
            yield SystemMessage(subtype="init", data={"model": "fake-model", "session_id": self.resume or "sdk-fake"})
            if "问" in text:
                result = await self.can_use_tool("Bash", {"command": "uv run pytest -q"}, SimpleNamespace(title="", description=""))
                denied = type(result).__name__ == "PermissionResultDeny"
                yield UserMessage(content=[ToolResultBlock(tool_use_id="t", is_error=denied, content="denied" if denied else "ok")])
            if "慢" in text:
                for n in range(6):
                    yield AssistantMessage(content=[TextBlock(text=f"第 {n} 步")])
                    await asyncio.sleep(0.25)
            yield AssistantMessage(content=[TextBlock(text=f"做完了（接着 {self.resume}）" if self.resume else "做完了")])
            yield ResultMessage(session_id=self.resume or "sdk-fake", total_cost_usd=0.01, is_error=False, subtype="success")

    async def interrupt(self):
        pass

    async def set_permission_mode(self, mode):
        pass
