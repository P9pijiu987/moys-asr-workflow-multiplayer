"""[multiplayer] 多人联机模式工程字段的宽松规范化。

工程数据只放在顶层 ``multiplayer``。这里只做不会丢数据的修正：字段缺失时什么都不做；
不认识的 schema、非对象值与未知子字段一律原样保留；绝不产生校验错误，
因此多人数据永远不会阻止工程加载或保存。完整规范化由浏览器端
``web/shared/utils/multiplayer-data.js`` 负责，两侧对已知字段保持同一语义。
"""
from __future__ import annotations

from typing import Any

MULTIPLAYER_SCHEMA = "maw.multiplayer.v1"
MULTIPLAYER_GROUP_COUNT = 12
MULTIPLAYER_TRACK_KEYS = ("main", "overlay", "extension")


def _is_group_id(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 3 or not value.startswith("g") or not value[1:].isdigit():
        return False
    return 1 <= int(value[1:]) <= MULTIPLAYER_GROUP_COUNT


def _is_cue_key(value: Any) -> bool:
    if not isinstance(value, str) or "/" not in value:
        return False
    track, _, segment_id = value.partition("/")
    return track in MULTIPLAYER_TRACK_KEYS and 0 < len(segment_id.strip()) <= 160


def normalize_multiplayer(project: dict[str, Any]) -> None:
    """就地修正 ``project["multiplayer"]``；只处理本版本 schema 的已知字段。"""
    data = project.get("multiplayer")
    if not isinstance(data, dict):
        return
    if data.get("schema", MULTIPLAYER_SCHEMA) != MULTIPLAYER_SCHEMA:
        return
    data["schema"] = MULTIPLAYER_SCHEMA
    data["enabled"] = data.get("enabled") is True
    cues = data.get("cues")
    if isinstance(cues, dict):
        data["cues"] = {
            key: value for key, value in cues.items()
            if _is_cue_key(key) and isinstance(value, dict)
        }
    for field in ("color_map", "speaker_map"):
        mapping = data.get(field)
        if isinstance(mapping, dict):
            data[field] = {
                key: value for key, value in mapping.items()
                if isinstance(key, str) and key.strip() and _is_group_id(value)
            }


def multiplayer_enabled(project: Any) -> bool:
    """工程是否开启了本版本可识别的多人联机模式。"""
    if not isinstance(project, dict):
        return False
    data = project.get("multiplayer")
    return (
        isinstance(data, dict)
        and data.get("schema", MULTIPLAYER_SCHEMA) == MULTIPLAYER_SCHEMA
        and data.get("enabled") is True
    )
