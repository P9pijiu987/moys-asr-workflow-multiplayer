"""[multiplayer] 多人联机模式头像的烧录与实际画面预览。

编辑器导出的 ASS 在末尾带两个自定义节（libass 与常见播放器会忽略）：

- ``[MAW Multiplayer Avatars]``：每个头像落点的起止毫秒、资源 id、PlayRes 坐标、
  尺寸、不透明度、裁切形状、图层（文字前 / 后）、淡入淡出与阴影；
- ``[MAW Multiplayer Assets]``：落点引用的图片（base64）。

这里用 Pillow 把每种头像预处理成带透明度、阴影与裁切的 PNG，再构造 ffmpeg
``filter_complex``：文字后的头像 → ``ass`` 字幕 → 文字前的头像。实际画面预览与烧录
共用同一个函数，保证两者结果一致；排版本身由编辑器的共享排版模块给出。
"""
from __future__ import annotations

import base64
import binascii
import io
import math
from dataclasses import dataclass
from pathlib import Path

AVATAR_SECTION = "[maw multiplayer avatars]"
ASSET_SECTION = "[maw multiplayer assets]"
AVATAR_SHAPES = frozenset({"circle", "rounded", "square"})
AVATAR_LAYERS = frozenset({"above", "below"})
# 静态头像以固定帧率循环输入；只影响淡入淡出的时间粒度。
AVATAR_INPUT_FPS = 30


class AvatarPlanError(ValueError):
    """头像节内容无法使用（图片损坏等）。"""


@dataclass(frozen=True, slots=True)
class AvatarShadow:
    color: str
    opacity: float
    blur: float
    x: float
    y: float


@dataclass(frozen=True, slots=True)
class AvatarPlacement:
    start_ms: int
    end_ms: int
    asset: str
    x: float
    y: float
    size: float
    opacity: float
    shape: str
    radius: float
    layer: str
    fade_in_ms: int
    fade_out_ms: int
    shadow: AvatarShadow | None


@dataclass(frozen=True, slots=True)
class AvatarPlan:
    placements: tuple[AvatarPlacement, ...]
    assets: dict[str, bytes]

    def active_at(self, time_ms: int) -> AvatarPlan:
        """只保留在给定时刻显示的落点（单帧渲染用）。"""
        active = tuple(item for item in self.placements if item.start_ms <= time_ms < item.end_ms)
        return AvatarPlan(active, {key: value for key, value in self.assets.items()
                                   if any(item.asset == key for item in active)})


def _float(value: str, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _shadow(value: str) -> AvatarShadow | None:
    if not value or value.strip() == "-":
        return None
    parts = value.strip().split(":")
    if len(parts) != 5 or not parts[0].startswith("#") or len(parts[0]) != 7:
        return None
    return AvatarShadow(parts[0].lower(), _float(parts[1], 60), max(0.0, _float(parts[2])),
                        _float(parts[3]), _float(parts[4]))


def parse_avatar_plan(ass_text: str) -> AvatarPlan | None:
    """解析 ASS 中的头像节；没有头像节或没有可用落点时返回 None。"""
    section = ""
    placements: list[AvatarPlacement] = []
    raw_assets: dict[str, bytes] = {}
    for raw_line in ass_text.splitlines():
        line = raw_line.strip()
        if line.startswith("["):
            section = line.lower()
            continue
        if section == AVATAR_SECTION and line.lower().startswith("avatar:"):
            fields = [field.strip() for field in line.partition(":")[2].split(",")]
            if len(fields) < 13:
                continue
            shape = fields[7] if fields[7] in AVATAR_SHAPES else "circle"
            layer = fields[9] if fields[9] in AVATAR_LAYERS else "above"
            start = int(_float(fields[0], -1))
            end = int(_float(fields[1], -1))
            size = _float(fields[5])
            if start < 0 or end <= start or size <= 0 or not fields[2]:
                continue
            placements.append(AvatarPlacement(
                start, end, fields[2], _float(fields[3]), _float(fields[4]), size,
                min(100.0, max(0.0, _float(fields[6], 100))), shape, min(0.5, max(0.0, _float(fields[8]))),
                layer, max(0, int(_float(fields[10]))), max(0, int(_float(fields[11]))), _shadow(fields[12]),
            ))
        elif section == ASSET_SECTION and line.lower().startswith("asset:"):
            asset_id, _, rest = line.partition(":")[2].strip().partition(",")
            _mime, _, data = rest.partition(",")
            try:
                raw_assets[asset_id.strip()] = base64.b64decode(data.strip(), validate=True)
            except (binascii.Error, ValueError):
                continue
    usable = tuple(item for item in placements if item.asset in raw_assets)
    if not usable:
        return None
    return AvatarPlan(usable, raw_assets)


def render_avatar_png(image_bytes: bytes, size: float, shape: str, radius: float,
                      opacity: float, shadow: AvatarShadow | None) -> tuple[bytes, int]:
    """把头像处理成 RGBA PNG：居中裁成正方形、缩放、按形状裁切、乘以不透明度、
    按 alpha 生成阴影。返回 (PNG 字节, 四周留白像素)；叠加位置需减去留白。"""
    try:
        from PIL import Image, ImageChops, ImageDraw, ImageFilter
    except ImportError as error:
        # 上游的主程序依赖与冻结包都刻意不含 Pillow（只在独立的 OCR 运行时中提供）。
        raise AvatarPlanError("头像烧录需要 Pillow，当前环境未安装（可运行 uv sync --group build 或安装 pillow）。") from error

    try:
        source = Image.open(io.BytesIO(image_bytes))
        source.load()
    except Exception as error:  # Pillow 对损坏图片抛出多种异常
        raise AvatarPlanError(f"头像图片无法读取：{error}") from error
    source = source.convert("RGBA")
    side = min(source.width, source.height)
    left = (source.width - side) // 2
    top = (source.height - side) // 2
    pixel = max(1, round(size))
    avatar = source.crop((left, top, left + side, top + side)).resize((pixel, pixel), Image.Resampling.LANCZOS)
    # 形状遮罩先在 4 倍尺寸绘制再缩小，边缘与 Canvas 的抗锯齿相近。
    scale = 4
    mask = Image.new("L", (pixel * scale, pixel * scale), 0)
    draw = ImageDraw.Draw(mask)
    box = (0, 0, pixel * scale - 1, pixel * scale - 1)
    if shape == "circle":
        draw.ellipse(box, fill=255)
    elif shape == "rounded":
        draw.rounded_rectangle(box, radius=max(0, radius) * pixel * scale, fill=255)
    else:
        draw.rectangle(box, fill=255)
    mask = mask.resize((pixel, pixel), Image.Resampling.LANCZOS)
    alpha = ImageChops.multiply(avatar.getchannel("A"), mask)
    if opacity < 100:
        alpha = alpha.point(lambda value: round(value * opacity / 100))
    avatar.putalpha(alpha)
    if shadow is None or shadow.opacity <= 0:
        output = io.BytesIO()
        avatar.save(output, format="PNG")
        return output.getvalue(), 0
    # Canvas 的 shadowBlur 约等于 2σ；四周按模糊范围与偏移留白，阴影不被裁掉。
    margin = math.ceil(shadow.blur * 2 + max(abs(shadow.x), abs(shadow.y))) + 1
    canvas = Image.new("RGBA", (pixel + margin * 2, pixel + margin * 2), (0, 0, 0, 0))
    color = tuple(int(shadow.color[index:index + 2], 16) for index in (1, 3, 5))
    shadow_alpha = alpha.point(lambda value: round(value * shadow.opacity / 100))
    shadow_layer = Image.new("RGBA", canvas.size, (*color, 0))
    shadow_mask = Image.new("L", canvas.size, 0)
    shadow_mask.paste(shadow_alpha, (margin + round(shadow.x), margin + round(shadow.y)))
    if shadow.blur > 0:
        shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(shadow.blur / 2))
    shadow_layer.putalpha(shadow_mask)
    canvas = Image.alpha_composite(canvas, shadow_layer)
    canvas.alpha_composite(avatar, (margin, margin))
    output = io.BytesIO()
    canvas.save(output, format="PNG")
    return output.getvalue(), margin


def _escape_expr(value: str) -> str:
    # filter_complex 中逗号分隔滤镜、单引号包裹表达式；表达式本身只含数字与函数名。
    return value.replace("'", "\\'")


def build_avatar_filter(plan: AvatarPlan, workdir: Path, ass_filter: str, *,
                        base_input: str = "0:v", time_offset_ms: int = 0,
                        rgb_output: bool = False, first_input_index: int = 1) -> tuple[list[str], str, str]:
    """构造头像叠加的 ffmpeg 参数。

    返回 (额外输入参数, filter_complex 文本, 输出标签)。顺序：文字后的头像 →
    ``ass_filter``（如 ``ass=filename='x.ass'``）→ 文字前的头像。``time_offset_ms`` 用于单帧
    渲染：主视频以 ``-ss … -copyts`` 读入时把头像流时间平移到同一时间轴。
    """
    workdir.mkdir(parents=True, exist_ok=True)
    inputs: list[str] = []
    prepared: dict[tuple, tuple[int, int]] = {}
    users: dict[int, list[int]] = {}
    for index, item in enumerate(plan.placements):
        key = (item.asset, round(item.size), item.shape, item.radius, item.opacity, item.shadow)
        if key not in prepared:
            data, margin = render_avatar_png(plan.assets[item.asset], item.size, item.shape,
                                             item.radius, item.opacity, item.shadow)
            path = workdir / f"avatar-{len(prepared)}.png"
            path.write_bytes(data)
            inputs.extend(["-loop", "1", "-framerate", str(AVATAR_INPUT_FPS), "-i", str(path)])
            prepared[key] = (first_input_index + len(prepared), margin)
        stream, _ = prepared[key]
        users.setdefault(stream, []).append(index)

    graph: list[str] = []
    copies: dict[int, str] = {}
    offset = f",setpts=PTS+{time_offset_ms / 1000:.3f}/TB" if time_offset_ms else ""
    for stream, indexes in users.items():
        labels = [f"m{stream}_{order}" for order in range(len(indexes))]
        graph.append(f"[{stream}:v]format=rgba{offset},split={len(indexes)}" + "".join(f"[{label}]" for label in labels))
        for order, index in enumerate(indexes):
            copies[index] = labels[order]

    base = f"[{base_input}]"
    if rgb_output:
        graph.append(f"{base}format=rgb24[base]")
        base = "[base]"
    current = base
    overlay_format = "rgb" if rgb_output else "auto"
    step = 0

    def overlay(index: int) -> None:
        nonlocal current, step
        item = plan.placements[index]
        stream = next(stream for stream, members in users.items() if index in members)
        margin = next(margin for (stream_index, margin) in prepared.values() if stream_index == stream)
        start = item.start_ms / 1000
        end = item.end_ms / 1000
        fades = ""
        if item.fade_in_ms:
            fades += f",fade=t=in:st={start:.3f}:d={item.fade_in_ms / 1000:.3f}:alpha=1"
        if item.fade_out_ms:
            fades += f",fade=t=out:st={max(start, end - item.fade_out_ms / 1000):.3f}:d={item.fade_out_ms / 1000:.3f}:alpha=1"
        source = copies[index]
        if fades:
            graph.append(f"[{source}]{fades.lstrip(',')}[f{index}]")
            source = f"f{index}"
        enable = _escape_expr(f"gte(t,{start:.3f})*lt(t,{end:.3f})")
        output = f"o{step}"
        graph.append(
            f"{current}[{source}]overlay=x={round(item.x) - margin}:y={round(item.y) - margin}"
            f":format={overlay_format}:shortest=1:enable='{enable}'[{output}]"
        )
        current = f"[{output}]"
        step += 1

    for index, item in enumerate(plan.placements):
        if item.layer == "below":
            overlay(index)
    graph.append(f"{current}{ass_filter}[subtitled]")
    current = "[subtitled]"
    for index, item in enumerate(plan.placements):
        if item.layer == "above":
            overlay(index)
    graph.append(f"{current}null[avatarout]")
    return inputs, ";".join(graph), "[avatarout]"
