"""网页里的 Claude Code 会话：用一个假的 SDK 客户端测，不调模型。

Claude Code sessions in the page, tested with a fake SDK client; no model is called.
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from idea_loom import sessions
from idea_loom.server import app


def kind(name):
    return type(name, (SimpleNamespace,), {})


AssistantMessage, UserMessage, ResultMessage = kind("AssistantMessage"), kind("UserMessage"), kind("ResultMessage")
TextBlock, ToolUseBlock, ToolResultBlock = kind("TextBlock"), kind("ToolUseBlock"), kind("ToolResultBlock")


def say(text):
    return AssistantMessage(content=[TextBlock(text=text)])


def done(cost=0.01):
    return ResultMessage(session_id="sdk-1", total_cost_usd=cost, is_error=False, subtype="success")


class Fake:
    """按剧本回话的假客户端。剧本里的 ("ask", 工具, 参数) 会去走真的权限回调。

    A fake client replying from a script. An ("ask", tool, input) item goes through the real permission callback.
    """

    made: list["Fake"] = []
    script: list[list] = []

    def __init__(self, cwd, mode, resume, can_use_tool):
        self.cwd, self.mode, self.resume, self.can_use_tool = cwd, mode, resume, can_use_tool
        self.prompts, self.modes, self.interrupted = [], [], 0
        Fake.made.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompts.append(prompt if isinstance(prompt, str) else [m async for m in prompt])

    async def receive_response(self):
        for item in Fake.script.pop(0) if Fake.script else [say("好"), done()]:
            if isinstance(item, tuple):
                _, tool, tool_input = item
                result = await self.can_use_tool(tool, tool_input, SimpleNamespace(title="", description=""))
                denied = type(result).__name__ == "PermissionResultDeny"
                yield UserMessage(content=[ToolResultBlock(tool_use_id="t", is_error=denied, content=result.message if denied else f"ok {getattr(result, 'updated_input', None)}")])
            else:
                yield item

    async def interrupt(self):
        self.interrupted += 1

    async def set_permission_mode(self, mode):
        self.modes.append(mode)


@pytest.fixture
def fake(seeded, monkeypatch):
    Fake.made, Fake.script = [], []
    sessions._live.clear()
    monkeypatch.setattr(sessions, "client_factory", Fake)
    monkeypatch.setattr(sessions.notify, "send", lambda *a, **k: 0)
    return Fake


async def until(session_id, status, limit=3.0):
    for _ in range(int(limit / 0.01)):
        if sessions.get(session_id).status == status:
            return sessions.get(session_id)
        await asyncio.sleep(0.01)
    raise AssertionError(f"没有等到 {status}，现在是 {sessions.get(session_id).status}")


def types(session_id):
    return [e["type"] for e in sessions.events(session_id)]


def test_a_conversation_keeps_going_and_everything_is_recorded_in_order(fake):
    async def main():
        fake.script = [[say("我先读代码。"), AssistantMessage(content=[ToolUseBlock(id="t1", name="Read", input={"file_path": "idea-loom/README.md"})]),
                        UserMessage(content=[ToolResultBlock(tool_use_id="t1", is_error=False, content="# idea-loom")]), say("读完了。"), done(0.02)],
                       [say("接着说。"), done(0.05)]]
        meta = await sessions.start(sessions.NewSession(text="/wishes 3b30", mode="plan", wish_id="w1"))
        assert (meta.title, meta.mode, meta.wish_id) == ("/wishes 3b30", "plan", "w1")
        meta = await until(meta.id, "idle")
        assert types(meta.id) == ["user", "status", "text", "tool", "tool_result", "text", "result", "status"]
        events = sessions.events(meta.id)
        assert [e["seq"] for e in events] == list(range(1, 9)) and events[3]["label"] == "在读 idea-loom/README.md"
        assert (meta.cost_usd, meta.sdk_session, meta.turns, meta.live) == (0.02, "sdk-1", 1, True)
        await sessions.say(meta.id, "继续")
        meta = await until(meta.id, "idle")
        assert fake.made[0].prompts == ["/wishes 3b30", "继续"] and len(fake.made) == 1 and meta.cost_usd == 0.05   # 同一个进程，同一段对话 / one process, one conversation
        assert sessions.events(meta.id, after=8)[0] == {**sessions.events(meta.id, after=8)[0], "type": "user", "text": "继续"}
        await sessions.close(meta.id)
        assert sessions.get(meta.id).status == "closed"

    asyncio.run(main())


def test_it_waits_for_the_owner_on_permissions_and_passes_the_reason_back(fake):
    async def main():
        edit = {"file_path": "idea-loom/src/a.py", "old_string": "x = 1", "new_string": "x = 2"}
        fake.script = [[("ask", "Edit", edit), ("ask", "Edit", edit), ("ask", "Bash", {"command": "uv run pytest -q"}), ("ask", "Bash", {"command": "uv run ruff"}),
                        ("ask", "Bash", {"command": "rm -rf build"}), done()]]
        meta = await sessions.start(sessions.NewSession(text="改一下", mode="default"))
        waiting = await until(meta.id, "waiting")
        request = sessions.events(meta.id)[-2]
        assert (request["type"], request["kind"], request["tool"], request["input"]) == ("request", "permission", "Edit", edit) and waiting.waiting_for == "在改 idea-loom/src/a.py"
        with pytest.raises(sessions.SessionError, match="在等你回答"):
            await sessions.say(meta.id, "快点")
        await sessions.answer(meta.id, request["request_id"], "deny", note="先别动这个文件")
        with pytest.raises(sessions.SessionError, match="已经回答过了"):
            await sessions.answer(meta.id, request["request_id"], "allow")

        async def next_request():
            await until(meta.id, "waiting")
            return [e for e in sessions.events(meta.id) if e["type"] == "request"][-1]

        second = await next_request()
        denied = [e for e in sessions.events(meta.id) if e["type"] == "tool_result"][0]
        assert denied["error"] and "先别动这个文件" in denied["text"] and "do not retry" in denied["text"]     # 让它明白这是人的决定 / it must read as the person's decision
        await sessions.answer(meta.id, second["request_id"], "allow")
        third = await next_request()
        assert third["tool"] == "Bash"
        await sessions.answer(meta.id, third["request_id"], "allow_always")                                    # 以后 uv 开头的命令都不用问 / commands starting with uv are no longer asked about
        fourth = await next_request()
        assert fourth["input"] == {"command": "rm -rf build"}                                                  # uv run ruff 没有来问，rm 仍然要问 / `uv run ruff` was not asked about, `rm` still is
        await sessions.answer(meta.id, fourth["request_id"], "deny")
        await until(meta.id, "idle")
        assert [e["decision"] for e in sessions.events(meta.id) if e["type"] == "resolved"] == ["deny", "allow", "allow_always", "deny"]

    asyncio.run(main())


def test_plans_and_questions_are_answered_in_the_page(fake):
    async def main():
        questions = [{"question": "用哪种？", "header": "做法", "multiSelect": False, "options": [{"label": "甲", "description": ""}, {"label": "乙", "description": ""}]}]
        fake.script = [[("ask", "AskUserQuestion", {"questions": questions}), ("ask", "ExitPlanMode", {"plan": "# 计划\n改 a.py"}), ("ask", "ExitPlanMode", {"plan": "# 计划 v2"}), done()]]
        meta = await sessions.start(sessions.NewSession(text="做这条愿望"))
        await until(meta.id, "waiting")
        asked = sessions.events(meta.id)[-2]
        assert (asked["kind"], asked["summary"]) == ("question", "用哪种？")
        await sessions.answer(meta.id, asked["request_id"], "answer", answers={"用哪种？": "乙"})
        await until(meta.id, "waiting")
        plan = [e for e in sessions.events(meta.id) if e["type"] == "request"][-1]
        assert plan["kind"] == "plan" and plan["input"]["plan"].startswith("# 计划")
        assert "乙" in [e for e in sessions.events(meta.id) if e["type"] == "tool_result"][0]["text"]
        await sessions.answer(meta.id, plan["request_id"], "reject", note="不要动测试")
        await until(meta.id, "waiting")
        rejected = [e for e in sessions.events(meta.id) if e["type"] == "tool_result"][1]
        assert rejected["error"] and "did not approve this plan" in rejected["text"] and "不要动测试" in rejected["text"]
        again = [e for e in sessions.events(meta.id) if e["type"] == "request"][-1]
        await sessions.answer(meta.id, again["request_id"], "approve_edits")
        meta = await until(meta.id, "idle")
        await asyncio.sleep(0.05)
        assert meta.mode == "acceptEdits" and fake.made[0].modes == ["acceptEdits"] and {"type": "mode", "mode": "acceptEdits"}.items() <= [e for e in sessions.events(meta.id) if e["type"] == "mode"][0].items()

    asyncio.run(main())


def test_interrupting_and_picking_up_after_a_restart(fake):
    async def main():
        fake.script = [[("ask", "Bash", {"command": "sleep 100"}), say("被打断了"), done()]]
        meta = await sessions.start(sessions.NewSession(text="跑一个很久的命令", mode="default"))
        await until(meta.id, "waiting")
        await sessions.interrupt(meta.id)
        meta = await until(meta.id, "idle")
        assert fake.made[0].interrupted == 1 and "interrupted" in types(meta.id)
        # idea-loom 重启：进程没了，记录还在。 / idea-loom restarts: the process is gone, the record remains.
        task = sessions._live[meta.id].task
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        sessions._live.clear()
        before = len(sessions.events(meta.id))
        assert sessions.get(meta.id).live is False and sessions.get(meta.id).sdk_session == "sdk-1"
        await sessions.say(meta.id, "还记得吗")
        await until(meta.id, "idle")
        assert len(fake.made) == 2 and fake.made[1].resume == "sdk-1" and fake.made[1].prompts == ["还记得吗"]     # 用存着的会话编号接上 / resumed with the stored session id
        assert [e["seq"] for e in sessions.events(meta.id)][before] == before + 1                                # 序号接着往下排 / sequence numbers carry on
        with pytest.raises(sessions.SessionError, match="模式只能是"):
            await sessions.set_mode(meta.id, "bypassPermissions")                                                # 没有"全部放行" / there is no "allow everything"
        await sessions.set_mode(meta.id, "acceptEdits")
        assert fake.made[1].modes == ["acceptEdits"]

    asyncio.run(main())


def test_images_and_the_limit_on_open_sessions(fake):
    async def main():
        first = await sessions.start(sessions.NewSession(text="看图", images=[{"media_type": "image/png", "data": "QUJD"}]))
        await until(first.id, "idle")
        (message,) = fake.made[0].prompts[0]
        assert [b["type"] for b in message["message"]["content"]] == ["text", "image"] and sessions.events(first.id)[0]["images"] == 1
        for n in range(sessions.MAX_LIVE - 1):
            await sessions.start(sessions.NewSession(text=f"第 {n} 个"))
        with pytest.raises(sessions.SessionError, match="同时最多开"):
            await sessions.start(sessions.NewSession(text="再来一个"))
        with pytest.raises(sessions.SessionError, match="不能空"):
            await sessions.start(sessions.NewSession(text="  "))
        assert len(sessions.listing()) == sessions.MAX_LIVE
        for live in list(sessions._live.values()):
            await sessions.close(live.meta.id)

    asyncio.run(main())


def test_only_the_owner_on_this_machine_in_local_mode(fake, monkeypatch):
    local = TestClient(app, base_url="http://localhost:8767")
    listed = local.get("/api/sessions").json()
    assert listed["sessions"] == [] and listed["unavailable"] is None and listed["billing"] == "subscription" and listed["modes"] == ["plan", "default", "acceptEdits"]
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert local.get("/api/sessions").json()["billing"] == "api_key"                     # 会按量计费，界面要说明 / billed per token, and the UI must say so
    assert local.get("/api/sessions/nope").status_code == 404
    assert TestClient(app, base_url="http://localhost:8767", client=("192.168.1.20", 5000)).get("/api/sessions").status_code == 403   # 局域网里的别人 / someone else on the LAN
    assert TestClient(app, base_url="http://strata.localhost:8767").get("/api/sessions").status_code != 200                              # 模拟自己的源 / a simulation's own origin
    assert local.get("/api/sessions", headers={"origin": "http://strata.localhost:8767"}).status_code == 403
    # 云端：没有这个功能；游客和访客更到不了。 / In the cloud the feature does not exist; guests and members get nowhere near it.
    monkeypatch.setenv("IDEA_LOOM_OWNER", "Carl")
    monkeypatch.setenv("IDEA_LOOM_SESSION_SECRET", "s")
    monkeypatch.setenv("IDEA_LOOM_PUBLIC_URL", "https://loom.example.com")
    monkeypatch.setenv("IDEA_LOOM_SIM_DOMAIN", "sim.example.com")
    from idea_loom import auth

    cloud = TestClient(app, base_url="https://loom.example.com")
    assert cloud.get("/api/sessions").status_code == 401 and cloud.post("/api/sessions", json={"text": "x"}).status_code == 401
    cloud.cookies.set(auth.COOKIE, auth.session_cookie("someone"))
    assert cloud.get("/api/sessions").status_code == 403
    cloud.cookies.set(auth.COOKIE, auth.session_cookie("carl"))
    assert cloud.get("/api/sessions").status_code == 404 and cloud.post("/api/sessions", json={"text": "x"}).status_code == 404
    assert sessions.available() == "网页里的 Claude Code 会话只在本机开放"
