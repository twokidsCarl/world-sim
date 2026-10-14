"""网页里的 Claude Code 会话：用一个假的 SDK 客户端测，不调模型。

Claude Code sessions in the page, tested with a fake SDK client; no model is called.
"""

import asyncio
import json
import os
import signal
import time
from pathlib import Path
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

    def __init__(self, cwd, mode, resume, can_use_tool, model="", effort=""):
        self.cwd, self.mode, self.resume, self.can_use_tool, self.model, self.effort = cwd, mode, resume, can_use_tool, model, effort
        self.prompts, self.modes, self.interrupted = [], [], 0
        self.queries: asyncio.Queue = asyncio.Queue()
        Fake.made.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompts.append(prompt if isinstance(prompt, str) else [m async for m in prompt])
        await self.queries.put(Fake.script.pop(0) if Fake.script else [say("好"), done()])

    async def receive_messages(self):
        # 和真的一样一直往下给，不按轮停；剧本里的 ("later", 秒, [...]) 是过一会儿自己冒出来的（后台任务做完后的那一轮）。
        # Like the real one it keeps yielding rather than stopping per turn; a ("later", seconds, [...]) item turns up by itself after a while (the turn after a background task ends).
        while True:
            for item in await self.queries.get():
                if isinstance(item, tuple) and item[0] == "later":
                    _, delay, items = item
                    asyncio.get_running_loop().call_later(delay, self.queries.put_nowait, items)
                    continue
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
    sessions._tasks.clear()
    monkeypatch.setattr(sessions, "client_factory", Fake)   # 有它在，会话"进程"是当前事件循环里的任务 / with it set, a session "process" is a task on this event loop
    monkeypatch.setattr(sessions.notify, "send", lambda *a, **k: 0)
    return Fake


async def until(session_id, status, limit=3.0):
    for _ in range(int(limit / 0.01)):
        if sessions.get(session_id).status == status:
            return sessions.get(session_id)
        await asyncio.sleep(0.01)
    raise AssertionError(f"没有等到 {status}，现在是 {sessions.get(session_id).status}")


async def kill(session_id):
    """会话进程突然没了（不是好好退出的）。 / The session process is suddenly gone (not a clean exit)."""
    task = sessions._tasks[session_id]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


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


def test_several_requests_at_once_all_wait_and_all_can_be_answered(fake):
    """它一次发起几个工具调用时，会同时有几个请求在等。曾经只有最后一个能回答，别的永远卡着。

    When it issues several tool calls at once, several requests wait together. Only the last used to be answerable and the rest hung forever.
    """
    async def main():
        class Parallel(Fake):
            async def receive_messages(self):
                await self.queries.get()
                paths = ["/tmp/narrow.png", "/tmp/wide.png", "/tmp/third.png"]
                results = await asyncio.gather(*(self.can_use_tool("Read", {"file_path": p}, SimpleNamespace(title="", description="")) for p in paths),
                                               self.can_use_tool("Bash", {"command": "rm x"}, SimpleNamespace(title="", description="")))
                yield say("、".join(type(r).__name__.removeprefix("PermissionResult") for r in results))
                yield done()
                await self.queries.get()   # 真的输出不会自己结束 / the real output never ends by itself

        sessions.client_factory = Parallel
        meta = await sessions.start(sessions.NewSession(text="看这几张图", mode="default"))
        await until(meta.id, "waiting")
        await asyncio.sleep(0.05)
        requests = [e for e in sessions.events(meta.id) if e["type"] == "request"]
        assert [r["input"].get("file_path") or r["input"].get("command") for r in requests] == ["/tmp/narrow.png", "/tmp/wide.png", "/tmp/third.png", "rm x"]
        await sessions.answer(meta.id, requests[3]["request_id"], "deny")                     # 先回答最后一个 / the last one is answered first
        await asyncio.sleep(0.05)
        still = sessions.get(meta.id)
        assert (still.status, still.waiting_for) == ("waiting", "在读 /tmp/narrow.png")        # 别的还在等，不算"在干活" / others still wait; it is not "working"
        await sessions.answer(meta.id, requests[1]["request_id"], "allow_always")              # 这一类以后都允许 / always allow this kind
        meta = await until(meta.id, "idle")
        assert [e["text"] for e in sessions.events(meta.id) if e["type"] == "text"] == ["Allow、Allow、Allow、Deny"]   # 同类的另外两个一并放行 / the other two of the same kind went through with it
        assert sorted(e["decision"] for e in sessions.events(meta.id) if e["type"] == "resolved") == ["allow", "allow", "allow_always", "deny"]

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
        await kill(meta.id)
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
        for one in sessions.listing():
            assert (await sessions.close(one.id)).status == "closed" and sessions.get(one.id).live is False

    asyncio.run(main())


def test_only_the_owner_on_this_machine_in_local_mode(fake, monkeypatch):
    local = TestClient(app, base_url="http://localhost:8767")
    listed = local.get("/api/sessions").json()
    assert listed["sessions"] == [] and listed["unavailable"] is None and listed["billing"] == "subscription" and listed["modes"] == ["plan", "default", "acceptEdits", "auto"] and listed["default_model"] == "claude-opus-5-5"
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


def test_commands_are_split_into_segments_and_each_gets_a_kind():
    command = 'tools/ci.sh idea-loom 2>&1 | grep -E "passed|failed|全部通过|Tests " ; git status --short idea-loom/'
    assert sessions.segments(command) == ["tools/ci.sh idea-loom 2>&1", 'grep -E "passed|failed|全部通过|Tests "', "git status --short idea-loom/"]   # 引号里的 | 不拆 / a | inside quotes does not split
    assert [sessions.kind_of(s) for s in sessions.segments(command)] == ["tools/ci.sh", "grep", "git status"]
    assert sessions.kind_of("FOO=1 uv run --project idea-loom pytest -q") == "uv run" and sessions.kind_of("git -C .. status") == "git status"
    assert sessions.segments("a && b || c\nd") == ["a", "b", "c", "d"]
    # 循环、条件、带着别的命令跑的程序：算的是真正要跑的那条 / loops, conditions and programs running another command: the kind is that of what really runs
    assert [sessions.kind_of(s) for s in sessions.segments("for f in a b; do git status; done; ls | xargs grep x; timeout 5 uv run pytest")] == ["for", "git status", "done", "ls", "grep", "uv run"]


def test_always_allow_goes_by_segment_and_what_the_owner_allowed_stays_allowed(fake):
    async def main():
        fake.script = [[("ask", "Bash", {"command": "tools/ci.sh idea-loom 2>&1 | grep passed ; git status --short"}),
                        ("ask", "Bash", {"command": "git status --short | grep M ; tools/ci.sh web"}),          # 同样的几类，换了写法和顺序 / the same kinds, written and ordered differently
                        ("ask", "Bash", {"command": "tools/ci.sh x | wc -l"}),                                  # 多了一段没见过的 / one segment never seen
                        ("ask", "Bash", {"command": "rm -rf ~/build"}), ("ask", "Bash", {"command": "rm -rf ~/dist"}), ("ask", "Bash", {"command": "ls"}), done()]]
        meta = await sessions.start(sessions.NewSession(text="跑测试", mode="default"))

        async def card():
            await until(meta.id, "waiting")
            return [e for e in sessions.events(meta.id) if e["type"] == "request"][-1]

        first = await card()
        assert [(s["kind"], s["known"]) for s in first["segments"]] == [("tools/ci.sh", False), ("grep", False), ("git status", False)] and "risky" not in first
        await sessions.answer(meta.id, first["request_id"], "allow_always")
        third = await card()
        assert third["input"]["command"] == "tools/ci.sh x | wc -l"                                             # 第二条没来问 / the second was not asked about
        assert [(s["kind"], s["known"]) for s in third["segments"]] == [("tools/ci.sh", True), ("wc", False)]   # 卡片上标出哪一段没见过 / the card marks the unseen segment
        await sessions.answer(meta.id, third["request_id"], "allow")
        removal = await card()
        assert removal["input"]["command"] == "rm -rf ~/build" and "risky" not in removal
        # 主人说了"以后都允许"就算数，不由我们再问一遍。 / The owner's "always allow" stands; we do not ask again.
        await sessions.answer(meta.id, removal["request_id"], "allow_always")
        last = await card()
        assert last["input"]["command"] == "ls"                                                                 # rm -rf ~/dist 没有来问 / `rm -rf ~/dist` was not asked about
        await sessions.answer(meta.id, last["request_id"], "deny")
        await until(meta.id, "idle")

    asyncio.run(main())


def test_auto_mode_model_and_effort(fake, monkeypatch):
    sent = []
    monkeypatch.setattr(sessions.notify, "send", lambda title, body="", **k: sent.append(title) or 0)

    async def main():
        init = kind("SystemMessage")(subtype="init", data={"model": "claude-opus-5-5", "session_id": "sdk-early"})
        fake.script = [[init, ("ask", "ExitPlanMode", {"plan": "# 计划"}), done()], [say("换了模型"), done()]]
        meta = await sessions.start(sessions.NewSession(text="做这条愿望", mode="plan"))
        await until(meta.id, "waiting")
        assert (meta.model, meta.effort) == ("claude-opus-5-5", "high") and (fake.made[0].model, fake.made[0].effort) == ("claude-opus-5-5", "high")
        early = sessions.get(meta.id)
        assert (early.sdk_session, early.model_used) == ("sdk-early", "claude-opus-5-5")        # 第一轮还没说完就记下了 / recorded before the first turn has ended
        plan = [e for e in sessions.events(meta.id) if e["type"] == "request"][-1]
        await sessions.answer(meta.id, plan["request_id"], "approve_auto")
        meta = await until(meta.id, "idle")
        await asyncio.sleep(0.05)
        assert meta.mode == "auto" and fake.made[0].modes == ["auto"] and "Claude Code 做完了一轮" in sent
        with pytest.raises(sessions.SessionError, match="模型只能是"):
            await sessions.set_engine(meta.id, "gpt", "high")
        with pytest.raises(sessions.SessionError, match="努力程度只能是"):
            await sessions.set_engine(meta.id, "claude-sonnet-5-5", "extreme")
        changed = await sessions.set_engine(meta.id, "claude-sonnet-5-5", "xhigh")
        assert (changed.model, changed.effort, changed.status, changed.live) == ("claude-sonnet-5-5", "xhigh", "idle", False)
        await sessions.say(meta.id, "接着做")
        await until(meta.id, "idle")
        assert (fake.made[1].model, fake.made[1].effort, fake.made[1].resume, fake.made[1].mode) == ("claude-sonnet-5-5", "xhigh", "sdk-1", "auto")   # 同一段对话，新的配置 / the same conversation, new settings
        with pytest.raises(sessions.SessionError, match="模型只能是"):
            await sessions.start(sessions.NewSession(text="x", model="nope"))

    asyncio.run(main())


def test_commands_are_files_read_whole_in_order_and_removed(fake):
    async def main():
        meta = await sessions.start(sessions.NewSession(text="第一句", mode="default"))
        await until(meta.id, "idle")
        inbox = sessions._inbox(meta.id)
        assert sessions._commands(meta.id) == []                                              # 收下就删掉 / removed once taken
        (inbox / ".half.tmp").write_text('{"kind": "say", "text": "写到一半')                   # 写到一半的不读 / a half-written one is not read
        (inbox / "00000000000000000001-bad.json").write_text("不是 JSON")                       # 坏的一条不会把会话带走 / a broken one does not take the session down
        fake.script = [[("ask", "Bash", {"command": "ls"}), ("ask", "Bash", {"command": "pwd"}), done()]]
        await sessions.say(meta.id, "第二句")
        await until(meta.id, "waiting")
        first, second = [e["request_id"] for e in sessions.events(meta.id) if e["type"] == "request"][:1] * 2
        # 两条命令几乎同时写下，按文件名的先后处理。 / Two commands written at almost the same moment are handled in file-name order.
        sessions._command(meta.id, "mode", mode="acceptEdits")
        sessions._command(meta.id, "mode", mode="auto")
        await sessions.answer(meta.id, first, "allow")
        await until(meta.id, "waiting")
        (later,) = sessions._open_requests(meta.id)
        await sessions.answer(meta.id, later, "allow")
        meta = await until(meta.id, "idle")
        assert [e["mode"] for e in sessions.events(meta.id) if e["type"] == "mode"] == ["acceptEdits", "auto"] and meta.mode == "auto"
        assert sessions._commands(meta.id) == [] and (inbox / ".half.tmp").exists() and "error" in types(meta.id)
        with pytest.raises(sessions.SessionError, match="已经回答过了"):
            await sessions.answer(meta.id, second, "allow")
        await sessions.close(meta.id)
        with pytest.raises(sessions.SessionError, match="没有在跑"):
            await sessions.interrupt(meta.id)

    asyncio.run(main())


def test_a_session_process_rests_when_idle_or_outdated_and_the_next_message_picks_it_up(fake, monkeypatch):
    async def main():
        stamp = [100.0]
        monkeypatch.setattr(sessions, "code_stamp", lambda: stamp[0])
        monkeypatch.setattr(sessions, "POLL", 0.01)
        fake.script = [[("ask", "Bash", {"command": "ls"}), done()]]
        meta = await sessions.start(sessions.NewSession(text="干活", mode="default"))
        await until(meta.id, "waiting")
        # 代码变新了，但它正忙（在等回答）：不退，这一轮照旧做完。 / The code got newer while it is busy (awaiting an answer): it stays and finishes the turn.
        stamp[0] = 200.0
        monkeypatch.setattr(sessions.time, "monotonic", lambda real=time.monotonic: real() + 10)   # 让"每两秒看一次代码"马上到期 / make the two-second code check due at once
        await asyncio.sleep(0.1)
        busy = sessions.get(meta.id)
        assert (busy.live, busy.stale, busy.status, busy.pid) == (True, True, "waiting", os.getpid())
        (request,) = sessions._open_requests(meta.id)
        await sessions.answer(meta.id, request, "allow")
        # 闲下来了，才自己退出；状态是"闲着"而不是"结束了"。 / Only once idle does it exit by itself, and the state is idle, not closed.
        assert await sessions._gone(meta.id, 3)
        rested = sessions.get(meta.id)
        assert (rested.live, rested.stale, rested.status, rested.sdk_session) == (False, False, "idle", "sdk-1") and len(fake.made) == 1
        await sessions.say(meta.id, "接着")
        again = await until(meta.id, "idle")
        assert len(fake.made) == 2 and fake.made[1].resume == "sdk-1" and again.live and not again.stale     # 新进程，同一段对话 / a new process, the same conversation
        # 闲得够久也退出。 / It also exits after being idle long enough.
        monkeypatch.setenv("IDEA_LOOM_SESSION_IDLE", "0.05")
        assert await sessions._gone(meta.id, 3) and sessions.get(meta.id).status == "idle"
        monkeypatch.setenv("IDEA_LOOM_SESSION_IDLE", "1800")
        await sessions.say(meta.id, "再来")
        await until(meta.id, "idle")
        assert len(fake.made) == 3 and sessions._count() == 1
        await sessions.close(meta.id)

    asyncio.run(main())


def test_a_real_session_process_outlives_the_backend(seeded, monkeypatch):
    """起一个真的会话进程（加载假的客户端）。"后端"在这里就是这个测试进程里的几个函数：状态全在盘上，
    所以"后端重启"等于什么都不记得、只凭盘上的东西接着用。

    A real session process is started (loading the fake client). The "backend" here is just these functions in the
    test process: all state is on disk, so a "backend restart" amounts to remembering nothing and carrying on from disk.
    """
    monkeypatch.setenv("IDEA_LOOM_SESSION_CLIENT", "fake_session_client:Client")
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).parent))
    monkeypatch.setattr(sessions, "client_factory", None)
    monkeypatch.setattr(sessions, "_recover", lambda meta: None)

    async def main():
        meta = await sessions.start(sessions.NewSession(text="慢慢做，然后问我", mode="default"))
        pid = sessions.get(meta.id).pid
        try:
            assert pid and pid != os.getpid() and os.getsid(pid) == pid                         # 自己一个会话组，和"后端"脱钩 / its own session, detached from the "backend"
            card = await until(meta.id, "waiting", limit=10)
            assert card.live and json.loads((sessions._dir(meta.id) / "runner.json").read_text())["pid"] == pid
            # "后端重启"：内存里什么都没有了，卡片照样能回答。 / A "backend restart": nothing in memory, and the card can still be answered.
            sessions._tasks.clear()
            (request,) = sessions._open_requests(meta.id)
            await sessions.answer(meta.id, request, "allow")
            assert sessions.get(meta.id).status == "running"                                    # 它接着干 / it carries on
            finished = await until(meta.id, "idle", limit=10)
            texts = [e["text"] for e in sessions.events(meta.id) if e["type"] == "text"]
            assert texts == [f"第 {n} 步" for n in range(6)] + ["做完了"] and finished.pid == pid and finished.sdk_session == "sdk-fake" and finished.model_used == "fake-model"
            # 终止信号（比如关机）：它收拾好再走，对话能接上。 / A termination signal (a shutdown, say): it tidies up and leaves, and the conversation can be picked up.
            os.kill(pid, signal.SIGTERM)
            assert await sessions._gone(meta.id, 5) and sessions.get(meta.id).status == "idle"
            await sessions.say(meta.id, "还在吗")
            resumed = await until(meta.id, "idle", limit=10)
            assert resumed.pid != pid and [e["text"] for e in sessions.events(meta.id) if e["type"] == "text"][-1] == "做完了（接着 sdk-fake）"
            assert (await sessions.close(meta.id)).status == "closed" and sessions._count() == 0
        finally:
            for one in sessions.listing():
                if one.pid and one.pid != os.getpid():
                    os.kill(one.pid, signal.SIGKILL)

    asyncio.run(main())


def test_heredoc_bodies_are_content_not_commands():
    command = "cat > tests/a.test.ts <<'EOF'\nimport { it } from 'vitest'\nit('a | b; c', () => {})\nEOF\nbun run typecheck 2>&1 | tail -5; bun run test"
    assert [sessions.kind_of(s) for s in sessions.segments(command)] == ["cat", "bun run", "tail", "bun run"]     # 文件内容不拆成一段段"命令" / the file's content is not split into "commands"
    rest, found = sessions.heredocs(command)
    assert "import" not in rest and found == [("cat > tests/a.test.ts <<'EOF'", "import { it } from 'vitest'\nit('a | b; c', () => {})")]
    assert sessions.heredocs("cat <<< 'x'; ls") == ("cat <<< 'x'; ls", [])                                         # <<< 不是 heredoc / <<< is not a heredoc


def test_subagents_are_followed_after_the_turn_ends_and_their_steps_are_kept_apart(fake, monkeypatch):
    """子 Agent 默认在后台跑：主 Agent 这一轮先说完，子 Agent 接着干，做完后 Claude Code 自己再开一轮。
    这些都要读到，子 Agent 的每一步要标明属于谁。

    Subagents run in the background by default: the main agent's turn ends first, the subagent keeps working, and
    when it is done Claude Code opens another turn by itself. All of that must be read, and each subagent step must
    say whose it is.
    """
    monkeypatch.setenv("IDEA_LOOM_SESSION_IDLE", "0.01")   # 闲一点点就会歇——除非还有后台任务 / it would rest almost at once, unless background tasks remain
    monkeypatch.setattr(sessions, "POLL", 0.01)
    Started, Progress, Notified = kind("TaskStartedMessage"), kind("TaskProgressMessage"), kind("TaskNotificationMessage")
    Updated, System = kind("TaskUpdatedMessage"), kind("SystemMessage")

    async def main():
        fake.script = [[AssistantMessage(content=[ToolUseBlock(id="ag1", name="Agent", input={"description": "查代码", "prompt": "看看", "run_in_background": True})], parent_tool_use_id=None),
                        Started(task_id="t1", tool_use_id="ag1", description="查代码", task_type="local_agent"),
                        UserMessage(content=[ToolResultBlock(tool_use_id="ag1", is_error=False, content="Async agent launched")], parent_tool_use_id=None),
                        AssistantMessage(content=[ToolUseBlock(id="b1", name="Bash", input={"command": "ls"})], parent_tool_use_id="ag1"),
                        Progress(task_id="t1", tool_use_id="ag1", description="Running ls", last_tool_name="Bash", usage={"tool_uses": 1}),
                        say("派出去了，等它回来"), done(),
                        ("later", 0.3, [UserMessage(content=[ToolResultBlock(tool_use_id="b1", is_error=False, content="a b")], parent_tool_use_id="ag1"),
                                        AssistantMessage(content=[TextBlock(text="看完了：两个文件")], parent_tool_use_id="ag1"),
                                        Updated(task_id="t1", patch={"status": "completed"}, status="completed", tool_use_id=None),
                                        Notified(task_id="t1", tool_use_id="ag1", status="completed", summary="看完了：两个文件", usage={"tool_uses": 1}),
                                        System(subtype="init", data={}), say("子 Agent 回来了：两个文件"), done(0.03)])]]
        meta = await sessions.start(sessions.NewSession(text="派个子 Agent 去查", mode="auto"))
        first = await until(meta.id, "idle")
        assert first.tasks == 1 and first.live                                                   # 这一轮说完了，子 Agent 还在跑 / the turn is over, the subagent still runs
        await asyncio.sleep(0.1)
        assert sessions.get(meta.id).live                                                        # 有后台任务，不歇 / background work keeps it from resting
        for _ in range(300):                                                                     # 等 Claude Code 自己开的那一轮做完 / wait for the turn Claude Code opens by itself
            if sessions.get(meta.id).turns == 2:
                break
            await asyncio.sleep(0.01)
        last = await until(meta.id, "idle")
        assert [e["status"] for e in sessions.events(meta.id) if e["type"] == "status"][-2:] == ["running", "idle"]
        assert last.tasks == 0 and last.turns == 2 and last.cost_usd == 0.03
        events = sessions.events(meta.id)
        assert [(e["type"], e.get("parent")) for e in events if e["type"] in ("tool", "tool_result", "text")] == [
            ("tool", None), ("tool_result", None), ("tool", "ag1"), ("text", None), ("tool_result", "ag1"), ("text", "ag1"), ("text", None)]
        tasks = [e for e in events if e["type"] == "task"]
        assert [(e["state"], e["tool_use_id"]) for e in tasks] == [("started", "ag1"), ("progress", "ag1"), ("done", "ag1"), ("done", "ag1")]   # 不带编号的那条也补上了 / the one without an id has it filled in
        assert tasks[-1]["summary"] == "看完了：两个文件"
        assert [e["type"] for e in events].count("resumed") == 1 and fake.made[0].prompts == ["派个子 Agent 去查"]
        assert await sessions._gone(meta.id, 3)                                                  # 做完了才歇 / it rests only once all is done

    asyncio.run(main())


def test_tokens_are_counted_per_session_live_and_logged(fake):
    """token 按会话累计；干活时有一个估计；每轮记进 runs/llm.jsonl，带着 Claude Code 的会话编号。

    Tokens add up per session; there is an estimate while it works; each turn goes into runs/llm.jsonl with Claude Code's session id.
    """
    from idea_loom import llm, store

    def reply(mid, out):
        return AssistantMessage(content=[TextBlock(text="…")], message_id=mid, usage={"input_tokens": 3, "output_tokens": out, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 20})

    def result(inp, out, read, write):
        return ResultMessage(session_id="sdk-1", total_cost_usd=0.01, is_error=False, subtype="success", usage={"input_tokens": 3, "output_tokens": 10},
                             model_usage={"claude-opus-5-5": {"inputTokens": inp, "outputTokens": out, "cacheReadInputTokens": read, "cacheCreationInputTokens": write}})

    async def main():
        # 一条回复拆成两条消息，用量递增：只算一次，取大的。 / One reply split in two messages with growing usage: counted once, the larger figures.
        fake.script = [[reply("m1", 5), reply("m1", 8), reply("m2", 4), result(10, 40, 3000, 60)],
                       [result(25, 90, 7000, 100)]]
        meta = await sessions.start(sessions.NewSession(text="干活", mode="plan"))
        meta = await until(meta.id, "idle")
        live = [e["tokens"] for e in sessions.events(meta.id) if e["type"] == "usage"]
        assert [t["output_tokens"] for t in live] == [5, 8, 12] and live[-1]["cache_read_input_tokens"] == 2000
        assert meta.tokens == {"input_tokens": 10, "output_tokens": 40, "cache_read_input_tokens": 3000, "cache_creation_input_tokens": 60}
        await sessions.say(meta.id, "继续")
        meta = await until(meta.id, "idle")
        # modelUsage 是累计的：第二轮报的就是总数。 / modelUsage is cumulative: the second turn reports the total.
        assert meta.tokens == {"input_tokens": 25, "output_tokens": 90, "cache_read_input_tokens": 7000, "cache_creation_input_tokens": 100}
        assert [e for e in sessions.events(meta.id) if e["type"] == "result"][-1]["tokens"] == meta.tokens
        # 进程换了，新进程从零记：加在以前的上面。 / A new process counts from zero: added on top of what came before.
        await kill(meta.id)
        fake.script = [[result(5, 30, 1000, 0)]]
        await sessions.say(meta.id, "还在吗")
        meta = await until(meta.id, "idle")
        assert meta.tokens == {"input_tokens": 30, "output_tokens": 120, "cache_read_input_tokens": 8000, "cache_creation_input_tokens": 100}
        rows = [r for r in store.read_lines(llm.runs_dir() / "llm.jsonl")[0] if r["purpose"] == "session"]
        assert [(r["session"], r["output_tokens"], r["cache_read_input_tokens"]) for r in rows] == [("sdk-1", 40, 3000), ("sdk-1", 50, 4000), ("sdk-1", 30, 1000)]
        await sessions.close(meta.id)

    asyncio.run(main())


def test_a_resumed_process_that_carries_on_the_total_is_not_counted_twice(fake):
    """续上的会话有时从记录里的总数接着记：那就不再加以前的。 / A resumed session sometimes carries on from the total in its transcript: then nothing is added."""

    def result(out, turn_out):
        return ResultMessage(session_id="sdk-1", total_cost_usd=0.01, is_error=False, subtype="success", usage={"output_tokens": turn_out},
                             model_usage={"m": {"inputTokens": 0, "outputTokens": out, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0}})

    async def main():
        fake.script = [[result(40, 40)]]
        meta = await sessions.start(sessions.NewSession(text="干活", mode="plan"))
        await until(meta.id, "idle")
        await kill(meta.id)
        fake.script = [[result(70, 30)]]
        await sessions.say(meta.id, "还在吗")
        meta = await until(meta.id, "idle")
        assert meta.tokens["output_tokens"] == 70
        await sessions.close(meta.id)

    asyncio.run(main())


def test_the_list_shows_each_sessions_subagents_running_and_back(seeded, monkeypatch):
    """左边的列表在每个会话下面列出它的子 Agent：这一轮派的和还没回来的，在跑还是回来了。

    The list on the left shows each session's subagents under it: those of this turn and those not back yet, running or back.
    """
    import fcntl

    from idea_loom import store

    monkeypatch.setattr(sessions, "SHOWN_AGENTS", 3)
    now = time.time()
    sessions._save(sessions.Meta(id="s-1", title="查东西", status="running", created_at=now, updated_at=now))
    agent = lambda seq, ag, what, bg=False: {"seq": seq, "type": "tool", "id": ag, "name": "Agent", "label": f"派了一个子 Agent：{what}", "input": {"description": what, "run_in_background": bg}}
    rows = [
        {"seq": 1, "type": "user", "text": "第一句"},
        agent(2, "old", "上一轮的，已经回来"), {"seq": 3, "type": "tool_result", "id": "old", "error": False, "text": "好了"},
        agent(4, "bg", "上一轮派的，还在后台跑", True), {"seq": 5, "type": "task", "task_id": "t", "tool_use_id": "bg", "state": "started"},
        {"seq": 6, "type": "tool_result", "id": "bg", "error": False, "text": "Async agent launched"},   # 后台的：马上返回不算回来 / background: the instant return is not coming back
        {"seq": 7, "type": "user", "text": "第二句"},
        agent(8, "a", "这一轮的，回来了"), {"seq": 9, "type": "tool_result", "id": "a", "error": False, "text": "好了"},
        agent(10, "b", "这一轮的，失败了"), {"seq": 11, "type": "tool_result", "id": "b", "error": True, "text": "坏了"},
        agent(12, "c", "这一轮的，在跑"),
        {"seq": 13, "type": "tool", "id": "x", "name": "Bash", "label": "在跑 ls", "input": {}, "parent": "c"},
    ]
    store.append(sessions._dir("s-1") / "events.jsonl", rows)
    # 进程在：在跑的就是在跑。最多三个，在跑的优先，回来的里面留最近的。 / Process up: running is running. Three at most, running first, the latest of those back.
    lock = (sessions._dir("s-1") / "runner.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        listed = {m.id: m for m in sessions.listing()}["s-1"]
        assert [(a.id, a.label, a.state) for a in listed.agents] == [("bg", "上一轮派的，还在后台跑", "running"), ("b", "这一轮的，失败了", "failed"), ("c", "这一轮的，在跑", "running")]
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
    # 后台的那个做完了；进程没了，没回来的算停下。 / The background one finished; with the process gone, the one not back counts as stopped.
    store.append(sessions._dir("s-1") / "events.jsonl", [{"seq": 14, "type": "task", "task_id": "t", "tool_use_id": "bg", "state": "done", "status": "completed"}])
    listed = {m.id: m for m in sessions.listing()}["s-1"]
    assert [(a.id, a.state) for a in listed.agents] == [("a", "done"), ("b", "failed"), ("c", "stopped")]
    # 列表里的子 Agent 不写进 meta.json。 / The listed subagents are not written to meta.json.
    assert "agents" not in store.read_json(sessions._dir("s-1") / "meta.json", {})
    client = TestClient(app, client=("127.0.0.1", 5000))
    assert [a["id"] for a in client.get("/api/sessions").json()["sessions"][0]["agents"]] == ["a", "b", "c"]
