"""[multiplayer] 工程 ``multiplayer`` 字段的宽松规范化与上游兼容（约束 C3）。"""
from __future__ import annotations

import copy
import unittest

from maw.multiplayer_project import multiplayer_enabled, normalize_multiplayer
from maw.project import normalize_project, validate_project


def _project(**extra: object) -> dict[str, object]:
    return {
        "schema": "moy.asr.project.v1",
        "segments": [{"id": "main-001", "start": 0, "end": 1000, "text": "你好"}],
        **extra,
    }


class MultiplayerProjectTests(unittest.TestCase):
    def test_absent_field_is_never_created(self) -> None:
        normalized = normalize_project(_project())
        self.assertNotIn("multiplayer", normalized)

    def test_known_fields_are_repaired_and_unknown_fields_preserved(self) -> None:
        data = {
            "schema": "maw.multiplayer.v1",
            "enabled": "yes",
            "future": {"keep": [1, 2]},
            "groups": [{"id": "g01", "name": "阿明", "extra": True}],
            "cues": {"main/main-001": {"group": "g02"}, "bad-key": {"group": "g01"}, "main/x": "nope"},
            "speaker_map": {"1": "g03", "2": "g99", "": "g01"},
        }
        normalized = normalize_project(_project(multiplayer=data))
        multiplayer = normalized["multiplayer"]
        self.assertIs(multiplayer["enabled"], False)
        self.assertEqual(multiplayer["future"], {"keep": [1, 2]})
        self.assertEqual(multiplayer["groups"], data["groups"])
        self.assertEqual(multiplayer["cues"], {"main/main-001": {"group": "g02"}})
        self.assertEqual(multiplayer["speaker_map"], {"1": "g03"})
        # 输入对象不被修改（normalize_project 基于深拷贝）。
        self.assertEqual(data["enabled"], "yes")

    def test_malformed_or_future_data_never_blocks_loading(self) -> None:
        for value in ("text", [1, 2], {"schema": "maw.multiplayer.v9", "enabled": "x", "cues": 3}):
            with self.subTest(value=value):
                result = validate_project(_project(multiplayer=copy.deepcopy(value)))
                self.assertTrue(result.ok, result.errors)
                self.assertEqual(result.project["multiplayer"], value)

    def test_avatar_fields_round_trip_unchanged(self) -> None:
        data = {
            "enabled": True,
            "avatar_defaults": {"position": "top", "shadow": {"enabled": True, "blur": 8}},
            "groups": [{"id": "g01", "avatar": "av-1", "avatar_style": {"position": "right"}}],
            "assets": {"av-1": {"mime": "image/png", "width": 8, "height": 8, "data": "iVBORw0KGgo="}},
        }
        normalized = normalize_project(_project(multiplayer=copy.deepcopy(data)))["multiplayer"]
        for key in ("avatar_defaults", "groups", "assets"):
            self.assertEqual(normalized[key], data[key])

    def test_enabled_helper(self) -> None:
        self.assertFalse(multiplayer_enabled(_project()))
        self.assertFalse(multiplayer_enabled(_project(multiplayer={"enabled": "true"})))
        self.assertFalse(multiplayer_enabled(_project(multiplayer={"schema": "other", "enabled": True})))
        self.assertTrue(multiplayer_enabled(_project(multiplayer={"enabled": True})))

    def test_normalize_is_idempotent(self) -> None:
        project = _project(multiplayer={"enabled": True, "cues": {"overlay/o-1": {"group": "g12"}}})
        once = normalize_project(project)
        twice = normalize_project(once)
        self.assertEqual(once, twice)
        direct = copy.deepcopy(project)
        normalize_multiplayer(direct)
        self.assertEqual(direct["multiplayer"], once["multiplayer"])


if __name__ == "__main__":
    unittest.main()
