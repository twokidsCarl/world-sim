"""案例库的检查：每个 YAML 都能加载、内容齐全；可运行的案例能复现原作；几条理论性质成立。"""

from __future__ import annotations

import pytest

from mindloop import runner
from mindloop.cases import all_cases

CASES = all_cases()
RUNNABLE = sorted(cid for cid, c in CASES.items() if c.runnable)
READ_ONLY = sorted(cid for cid, c in CASES.items() if not c.runnable)
GAME_CATEGORIES = ["implicature", "bluff", "coordination", "cheap_talk"]

EXPECTED = {
    "implicature": {"scalar_some", "grice_letter", "jilei", "daiyu_handwarmer", "hongmen", "veiled_bribe"},
    "bluff": {"kongchengji", "poe_even_odd", "huarongdao", "princess_bride", "holmes_moriarty", "jianggan", "maiguai"},
    "coordination": {"schelling_nyc", "palm_fire", "keynes_beauty", "gift_of_magi"},
    "cheap_talk": {"crawford_sobel", "zouji", "collins_proposal", "yes_minister"},
    "common_knowledge": {"friends_they_know", "zhuangzi_fish", "email_game", "muddy_children"},
}


def compute(case_id: str, **kw) -> dict:
    return runner.compute(runner.Params(case_id=case_id, **kw))


# ---------- 内容完整性 ----------


def test_library_is_complete():
    for category, ids in EXPECTED.items():
        have = {cid for cid, c in CASES.items() if c.category == category}
        assert ids <= have, f"{category} 缺少: {ids - have}"


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_case_has_required_text(case_id):
    c = CASES[case_id]
    assert c.title.strip() and c.hook.strip() and c.summary.strip()
    assert c.source.work.strip()
    for person in (c.a, c.b):
        assert person.name.strip() and person.persona.strip() and person.goal.strip()


@pytest.mark.parametrize("case_id", READ_ONLY)
def test_read_only_case_has_layers(case_id):
    layers = CASES[case_id].layers
    assert len(layers) >= 3
    assert all(isinstance(s, str) and s.strip() for s in layers)


@pytest.mark.parametrize("category", GAME_CATEGORIES)
def test_category_has_runnable_cases(category):
    assert sum(1 for c in CASES.values() if c.category == category and c.runnable) >= 2


def test_theory_cases_flagged():
    assert CASES["scalar_some"].theory and CASES["crawford_sobel"].theory


# ---------- 可运行的案例：引擎复现原作 ----------


@pytest.mark.parametrize("case_id", RUNNABLE)
def test_runnable_case_computes(case_id):
    res = compute(case_id)
    assert res["analysis"]["verdict"] in {"converged", "cycle", "unsettled"}
    assert len(res["towers"]["a"]) == res["depth"]["a"] + 1
    assert len(res["towers"]["b"]) == res["depth"]["b"] + 1


@pytest.mark.parametrize(
    "case_id", [cid for cid in RUNNABLE if CASES[cid].canonical.choice_a or CASES[cid].canonical.choice_b]
)
def test_canonical_match(case_id):
    c = CASES[case_id].canonical
    assert c.depth_a is not None and c.depth_b is not None, "有原作结局就应写明两人的层数"
    res = compute(case_id)
    assert res["canonical_match"]["all"], f"{case_id}: 引擎结局与原作不符 {res['canonical_match']}"


@pytest.mark.parametrize("case_id", RUNNABLE)
def test_canonical_choices_are_real_labels(case_id):
    c = CASES[case_id]
    g = c.game
    if g.kind == "signaling":
        a_labels, b_labels = [m.text for m in g.messages], g.actions
    else:
        a_labels, b_labels = g.actions_a, g.actions_b
    assert c.canonical.choice_a is None or c.canonical.choice_a in a_labels
    assert c.canonical.choice_b is None or c.canonical.choice_b in b_labels


# ---------- 理论性质 ----------


def test_scalar_implicature_strengthens_with_depth():
    """听到「有些」后相信「不是全部」的程度：第 2 层高于第 0 层。"""
    g = CASES["scalar_some"].game
    some = [m.text for m in g.messages].index("有些及格了")
    not_all = g.states.index("有些但不是全部")
    levels = compute("scalar_some")["analysis"]["levels"]
    b0, b2 = levels[0]["b"]["belief"][some][not_all], levels[2]["b"]["belief"][some][not_all]
    assert b2 > b0 + 0.1
    assert b2 > 0.9


@pytest.mark.parametrize("case_id", ["kongchengji", "huarongdao", "poe_even_odd"])
def test_bluff_cases_cycle(case_id):
    assert compute(case_id)["analysis"]["verdict"] == "cycle"


@pytest.mark.parametrize("case_id", ["princess_bride", "holmes_moriarty"])
def test_more_bluffs_cycle(case_id):
    assert compute(case_id)["analysis"]["verdict"] == "cycle"


def test_schelling_coordination_rises_with_depth():
    levels = compute("schelling_nyc")["analysis"]["levels"]
    match = [lv["metrics"]["match"] for lv in levels]
    assert match[1] > match[0]
    assert match[6] > match[1]
    assert match[-1] > 0.9


def test_crawford_sobel_information_falls_with_bias():
    info = [compute("crawford_sobel", bias=b)["equilibrium"]["metrics"]["info_bits"] for b in (0.0, 0.7, 1.5, 4.0)]
    assert info[0] > 1.5  # 无私心：句句可信，只剩 softmax 的手抖（上限 log2(5)≈2.32）
    assert info[-1] < 0.1  # 私心极大：说什么都没用
    assert all(x >= y - 1e-6 for x, y in zip(info, info[1:])), info


def test_keynes_guess_steps_down_each_level():
    levels = compute("keynes_beauty")["analysis"]["levels"]
    picks = [lv["a"]["choice"][0] for lv in levels[:5]]
    assert picks == [0, 1, 2, 3, 4]


def test_gift_of_magi_fails_at_equal_depth():
    """两人层数相同则礼物落空（非对角），层数错开一层才协调得上。"""
    same = compute("gift_of_magi", depth_a=1, depth_b=1)["outcome"]
    apart = compute("gift_of_magi", depth_a=1, depth_b=2)["outcome"]
    assert same["choice_a"] != same["choice_b"]
    assert apart["choice_a"] == apart["choice_b"]
    assert apart["payoff_a"] > same["payoff_a"]
