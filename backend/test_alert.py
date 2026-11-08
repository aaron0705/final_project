from alert import AlertEngine, classify_direction


def run(engine, seq, dt=0.1):
    """seq: list[(direction, seconds)] -> trả về list trạng thái active theo từng bước."""
    t, out = 0.0, []
    for direction, seconds in seq:
        for _ in range(int(round(seconds / dt))):
            out.append((round(t, 2), engine.update(direction, t)["active"]))
            t += dt
    return out


def first_active(out):
    return next((t for t, a in out if a), None)


def test_classify():
    assert classify_direction(0, 0) == "FORWARD"
    assert classify_direction(-30, 0) == "LEFT"
    assert classify_direction(30, 0) == "RIGHT"
    assert classify_direction(0, 25) == "UP"
    assert classify_direction(0, -25) == "DOWN"


def test_warning_after_2s():
    out = run(AlertEngine(), [("LEFT", 4)])
    t = first_active(out)
    assert t is not None and 1.9 <= t <= 2.2


def test_no_warning_for_short_glance():
    out = run(AlertEngine(), [("FORWARD", 1), ("RIGHT", 1.5), ("FORWARD", 3)])
    assert not any(a for _, a in out)


def test_warning_clears_when_looking_straight():
    out = run(AlertEngine(), [("LEFT", 3), ("FORWARD", 2)])
    assert out[-1][1] is False
    assert any(a for _, a in out)


def test_noise_does_not_reset_timer():
    # lệch hướng nhưng có 0.2s nhìn thẳng thoáng qua -> không được reset đồng hồ
    out = run(AlertEngine(), [("LEFT", 1.2), ("FORWARD", 0.2), ("LEFT", 1.5)])
    assert any(a for _, a in out)


def test_no_flicker_on_off_boundary():
    out = run(AlertEngine(), [("LEFT", 3), ("FORWARD", 0.2), ("LEFT", 1), ("FORWARD", 0.2), ("LEFT", 1)])
    states = [a for _, a in out]
    changes = sum(1 for a, b in zip(states, states[1:]) if a != b)
    assert changes == 1       # chỉ bật 1 lần, không nhấp nháy


def test_short_face_loss_is_ignored():
    out = run(AlertEngine(), [("FORWARD", 1), ("NO_FACE", 0.5), ("FORWARD", 2)])
    assert not any(a for _, a in out)


def test_long_face_loss_warns():
    out = run(AlertEngine(), [("NO_FACE", 5)])
    t = first_active(out)
    assert t is not None and t >= 2.0
    e = AlertEngine()
    for i in range(50):
        r = e.update("NO_FACE", i * 0.1)
    assert r["code"] == "NO_FACE"


def test_low_confidence_treated_as_uncertain():
    e = AlertEngine()
    r = None
    for i in range(10):
        r = e.update("LEFT", i * 0.1, confidence=0.2)
    assert r["active"] is False
