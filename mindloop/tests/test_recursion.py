import numpy as np
import pytest

from mindloop import recursion, runner
from mindloop.model import Message, Signaling, Simultaneous

LAM = {"a": 2.0, "b": 2.0}


def empty_city() -> Signaling:
    return Signaling(
        states=["弱", "强"],
        prior=[0.5, 0.5],
        messages=[Message(text="开门"), Message(text="闭门")],
        actions=["攻", "退"],
        literal=[[0.9, 0.1], [0.3, 0.7]],
        u_a=[[-10, 5], [8, 0]],
        u_b=[[10, -3], [-8, 0]],
    )


def pennies() -> Simultaneous:
    return Simultaneous(
        actions_a=["单", "双"],
        actions_b=["猜单", "猜双"],
        salience_a=[0.7, 0.3],
        salience_b=[0.3, 0.7],
        u_a=[[-1, 1], [1, -1]],
        u_b=[[1, -1], [-1, 1]],
    )


@pytest.mark.parametrize("game", [empty_city(), pennies()])
def test_policies_are_distributions(game):
    for role in ("a", "b"):
        for lv in recursion.tower(game, role, 6, LAM):
            assert np.allclose(lv.policy.sum(axis=1), 1)
            assert (lv.policy >= 0).all()
            if lv.belief is not None:
                assert np.allclose(lv.belief.sum(axis=1), 1)


def test_tower_alternates_roles_and_ends_with_owner():
    t = recursion.tower(empty_city(), "a", 3, LAM)
    assert [lv.role for lv in t] == ["b", "a", "b", "a"]
    t = recursion.tower(empty_city(), "b", 2, LAM)
    assert [lv.role for lv in t] == ["b", "a", "b"]


def test_empty_city_flips_with_depth():
    g = empty_city()
    open_gate = 0
    # 听者：字面 -> 攻；想两层 -> 退；想四层 -> 又攻
    assert recursion.tower(g, "b", 0, LAM)[-1].choice(open_gate) == 0
    assert recursion.tower(g, "b", 2, LAM)[-1].choice(open_gate) == 1
    assert recursion.tower(g, "b", 4, LAM)[-1].choice(open_gate) == 0
    # 说话者（弱）：想一层 -> 闭门；想三层 -> 开门
    assert recursion.tower(g, "a", 1, LAM)[-1].choice(0) == 1
    assert recursion.tower(g, "a", 3, LAM)[-1].choice(0) == 0


def test_cycle_detected_and_limit_is_uninformative():
    g = empty_city()
    res = recursion.analyze(g, 12, LAM)
    assert res["verdict"] == "cycle" and res["period"] == 4
    eq = recursion.equilibrium(g, {"a": 1.0, "b": 1.0})
    assert eq["metrics"]["info_bits"] < 0.05  # 无限层之后，开不开门都不再透露信息


def test_matching_pennies_limit_is_half_half():
    eq = recursion.equilibrium(pennies(), LAM)
    assert np.allclose(eq["a"]["policy"][0], [0.5, 0.5], atol=0.02)
    assert np.allclose(eq["b"]["policy"][0], [0.5, 0.5], atol=0.02)


def test_pin_changes_outer_levels():
    g = empty_city()
    free = recursion.tower(g, "a", 3, LAM)
    assert free[3].policy[0, 0] > 0.95  # 以为司马懿会退 -> 放心开门
    # 钉住第 2 层：「不，他看到开门会进攻」
    pinned = recursion.tower(g, "a", 3, LAM, pins={2: {0: 0}})
    assert pinned[2].pinned == {0: 0}
    assert pinned[2].choice(0) == 0
    assert pinned[3].policy[0, 0] < 0.7  # 开不开门他都会攻 -> 开门不再是妙计
    assert np.allclose(pinned[2].policy.sum(axis=1), 1)


def test_outcome_and_forced_choice():
    g = empty_city()
    a, b = recursion.tower(g, "a", 3, LAM)[-1], recursion.tower(g, "b", 2, LAM)[-1]
    out = recursion.outcome(g, a, b)
    assert (out["choice_a"], out["choice_b"]) == (0, 1)
    assert out["payoff_a"] == 5 and out["payoff_b"] == -3
    assert out["guessed_right"] is False
    forced = recursion.outcome(g, a, b, forced_b=0)
    assert forced["choice_b"] == 0 and forced["payoff_a"] == -10


def test_equivalent_depth():
    g = empty_city()
    depths = recursion.equivalent_depth(g, "b", LAM, row=0, col=1, max_depth=8)
    assert 2 in depths and 0 not in depths and 4 not in depths


def test_quadratic_bias_rebuilds_payoffs():
    g = Signaling(
        states=["低", "高"],
        prior=[0.5, 0.5],
        messages=[Message(text="说低"), Message(text="说高")],
        actions=["估低", "估高"],
        literal=[[1, 0.1], [0.1, 1]],
        quadratic={"state_values": [0, 1], "action_values": [0, 1], "bias": 0},
    )
    assert g.u_a == g.u_b
    g.apply_bias(1.0)
    assert g.u_a[0][1] > g.u_a[0][0]  # 有私心后，状态低也希望被估高
    assert g.u_b[0][0] > g.u_b[0][1]


def test_runner_compute_shape_and_extra_message():
    res = runner.compute(runner.Params(case_id="kongchengji"))
    assert res["depth"] == {"a": 3, "b": 2}
    assert len(res["towers"]["a"]) == 4 and len(res["towers"]["b"]) == 3
    assert all(lv["line"] for lv in res["towers"]["a"])
    assert res["canonical_match"]["all"] is True
    res = runner.compute(
        runner.Params(case_id="kongchengji", extra_messages=[{"text": "城头遍插旌旗", "literal": [0.2, 0.8]}], forced_a=2, forced_b=0)
    )
    assert res["game"]["messages"][2]["text"] == "城头遍插旌旗"
    assert res["outcome"]["choice_a"] == 2
    assert "a" in res["played"] and "b" in res["played"]
    # 加话不应污染缓存里的原案例
    assert len(runner.compute(runner.Params(case_id="kongchengji"))["game"]["messages"]) == 2
