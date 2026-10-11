from idea_loom.markdown import parse

SAMPLE = """## 5. 脉络

| 层 | 基元 | 这一层新出现的东西 | 已有项目 |
|---|---|---|---|
| L1 物质 | 粒子 | 温度、压强 | strata |

- **A 传播**：一个东西传给下一个。

## 6. Idea 池

### L1 物质（已有：strata）

**1.1 往上走一层**（E）
第一行。
第二行。

**1.2 沙堆**（A、B）
只有一行。

### 纵线：同一件事穿过所有层

这几条不属于某一层。

**纵 1 一杯酒**
一杯酒喝下去。

**10.6 一片公用的牧场**（C、B）
放错了地方的一条。

## 7. 按内核聚类

| 内核 | 底下在算什么 | 已有 | 条数 | 归在这里的 idea |
|---|---|---|---|---|
| **粒子** | 很多个点 | strata | 1 | 1.1 |
| **阈值与级联** | 攒够了就翻转 | — | 2 | 1.2、10.6 |

**这一行是粗体但不是条目。** 后面是说明。
"""


def test_entries_with_and_without_tags():
    p = parse(SAMPLE)
    assert [(e.id, e.title, e.threads) for e in p.entries] == [
        ("1.1", "往上走一层", ["E"]),
        ("1.2", "沙堆", ["A", "B"]),
        ("纵 1", "一杯酒", []),
        ("10.6", "一片公用的牧场", ["C", "B"]),
    ]
    assert p.entries[0].body == "第一行。\n第二行。"
    assert p.entries[1].body == "只有一行。"


def test_tables_and_intro():
    p = parse(SAMPLE)
    assert p.levels == [("L1", "物质", "粒子", "温度、压强")]
    assert p.threads == [("A", "传播", "一个东西传给下一个。")]
    assert p.kernel_rows == [("粒子", "很多个点", "strata"), ("阈值与级联", "攒够了就翻转", "")]
    assert p.kernels == {"1.1": "粒子", "1.2": "阈值与级联", "10.6": "阈值与级联"}
    assert p.intros == {"纵": "这几条不属于某一层。"}
