# mindloop

两个人互相猜对方心思的模拟器：A 说话，B 猜 A 的意思；A 知道 B 会猜，B 知道 A 知道……
每多想一层，结论可能翻转一次。mindloop 把这种递归算出来、画出来，并配上来自小说、史书、喜剧和博弈论经典的真实案例。

## 运行

```bash
uv sync
uv run mindloop serve          # 打开 http://127.0.0.1:8765
```

内心独白由本机的 `claude -p` 生成，不需要 API key；没有 `claude` 时界面照常工作，只显示推理结论。

## 命令行

| 命令 | 作用 |
|---|---|
| `mindloop list` | 案例库（▶ 可运行，· 只有文字讲解） |
| `mindloop run kongchengji -a 3 -b 2` | 打印两个人脑中的塔和结局 |
| `mindloop sweep kongchengji -d 12` | 层数一路加深：收敛还是震荡，无限层的极限 |
| `mindloop narrate kongchengji` | 同 `run`，每层配一段 claude 写的内心独白 |
| `mindloop export <案例> -o out.jsonl` | 导出带独白的完整记录 |
| `mindloop bench generate` / `bench run bench.jsonl` | 由引擎出题、给标准答案，测模型的递归心智能力 |

## 原理

每个案例是一个小博弈（`cases/<类别>/<id>.yaml`）：

- **信号博弈**：a 知道隐藏的实情，说一句话；b 听到后形成判断并行动。
- **同时博弈**：两人各选一个行动，互相看不到。

第 0 层不动脑筋（照字面 / 凭直觉）；第 d 层针对「对方的第 d-1 层」做最优回应。
想到第 d 层的人脑中是一座塔：自己(d) ⊃ 对方(d-1) ⊃ 自己(d-2) ⊃ … ⊃ 第 0 层。
数值由 `recursion.py` 精确算出；文字独白由 `narrative.py` 让 claude 按每层的结论来写。

## 案例

五类：言外之意、虚张声势、默契协调、话里有私心、无限层与共同知识。
每个案例带出处；`source.verified: true` 表示回目和引文已对照原文核对过。

## 环境变量

`MINDLOOP_MODEL`（默认 sonnet）、`MINDLOOP_CLAUDE_BIN`、`MINDLOOP_CACHE`、`MINDLOOP_TIMEOUT`、`MINDLOOP_CASES`。

## 测试

```bash
uv run pytest -q
```
