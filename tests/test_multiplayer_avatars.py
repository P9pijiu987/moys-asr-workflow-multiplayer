"""[multiplayer] 头像烧录：ASS 头像节解析、Pillow 预处理、ffmpeg 滤镜链与真实烧录。"""
from __future__ import annotations

import base64
import io
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    from PIL import Image
except ImportError:  # 上游主依赖不含 Pillow；未安装时跳过需要它的用例
    Image = None

from maw.multiplayer_avatars import (
    AvatarShadow,
    build_avatar_filter,
    parse_avatar_plan,
    render_avatar_png,
)
from maw.postprocess_ffmpeg import BurnSubtitleRequest, run_burn_subtitles


needs_pillow = unittest.skipIf(Image is None, "需要 Pillow（uv sync --group build）")


def _png(color: tuple[int, int, int], size: tuple[int, int] = (80, 40)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def _ass(avatar_lines: list[str], assets: dict[str, bytes], width: int = 320, height: int = 180) -> str:
    return "\n".join([
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: MP01,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        "Dialogue: 0,0:00:00.00,0:00:01.50,MP01,,0,0,0,,{\\an1\\pos(200,170)}hi",
        "",
        "[MAW Multiplayer Avatars]",
        "Format: Start, End, Asset, X, Y, Size, Opacity, Shape, Radius, Layer, FadeIn, FadeOut, Shadow",
        *avatar_lines,
        "",
        "[MAW Multiplayer Assets]",
        "Format: Asset, Mime, Data",
        *[f"Asset: {key},image/png,{base64.b64encode(value).decode()}" for key, value in assets.items()],
        "",
    ])


@needs_pillow
class AvatarPlanParsingTests(unittest.TestCase):
    def test_parses_placements_and_drops_invalid_lines(self) -> None:
        text = _ass([
            "Avatar: 500,1500,av1,100.5,40,64,80,rounded,0.25,below,200,300,#112233:50:6:2:3",
            "Avatar: 1500,1000,av1,0,0,10,100,circle,0,above,0,0,-",  # 结束早于开始
            "Avatar: 0,100,missing,0,0,10,100,circle,0,above,0,0,-",  # 引用不存在的资源
            "Avatar: 0,100,av1,0,0,10",  # 字段不足
        ], {"av1": _png((255, 0, 0))})
        plan = parse_avatar_plan(text)
        self.assertIsNotNone(plan)
        self.assertEqual(len(plan.placements), 1)
        item = plan.placements[0]
        self.assertEqual((item.start_ms, item.end_ms, item.asset, item.x, item.y, item.size), (500, 1500, "av1", 100.5, 40.0, 64.0))
        self.assertEqual((item.opacity, item.shape, item.radius, item.layer, item.fade_in_ms, item.fade_out_ms),
                         (80.0, "rounded", 0.25, "below", 200, 300))
        self.assertEqual(item.shadow, AvatarShadow("#112233", 50.0, 6.0, 2.0, 3.0))
        self.assertEqual(len(plan.active_at(1000).placements), 1)
        self.assertEqual(plan.active_at(1500).placements, ())

    def test_plain_ass_without_avatar_sections_has_no_plan(self) -> None:
        self.assertIsNone(parse_avatar_plan("[Script Info]\nPlayResX: 1\n[Events]\n"))


@needs_pillow
class AvatarImageTests(unittest.TestCase):
    def test_circle_crop_opacity_and_square_crop(self) -> None:
        data, margin = render_avatar_png(_png((0, 255, 0), (120, 60)), 40, "circle", 0, 50, None)
        image = Image.open(io.BytesIO(data))
        self.assertEqual(margin, 0)
        self.assertEqual(image.size, (40, 40))
        self.assertEqual(image.getpixel((0, 0))[3], 0, "circle corner is transparent")
        center = image.getpixel((20, 20))
        self.assertEqual(center[:3], (0, 255, 0))
        self.assertAlmostEqual(center[3], 128, delta=2)

    def test_shadow_extends_canvas_and_follows_alpha(self) -> None:
        shadow = AvatarShadow("#000000", 100, 4, 0, 6)
        data, margin = render_avatar_png(_png((255, 255, 255)), 30, "square", 0, 100, shadow)
        image = Image.open(io.BytesIO(data))
        self.assertGreater(margin, 6)
        self.assertEqual(image.size, (30 + margin * 2, 30 + margin * 2))
        # 头像下方偏移处出现阴影（深色、半透明以上），上方对称位置没有。
        below = image.getpixel((margin + 15, margin + 30 + 3))
        above = image.getpixel((margin + 15, margin - 3))
        self.assertGreater(below[3], 60)
        self.assertLess(below[0], 40)
        self.assertLess(above[3], below[3])


@needs_pillow
class AvatarFilterTests(unittest.TestCase):
    def test_layer_order_fades_and_shared_inputs(self) -> None:
        text = _ass([
            "Avatar: 0,1000,av1,10,10,32,100,circle,0,below,0,0,-",
            "Avatar: 1000,2000,av1,10,10,32,100,circle,0,below,250,250,-",
            "Avatar: 0,2000,av1,100,10,32,100,circle,0,above,0,0,-",
        ], {"av1": _png((255, 0, 0))})
        plan = parse_avatar_plan(text)
        with tempfile.TemporaryDirectory() as directory:
            inputs, graph, output = build_avatar_filter(plan, Path(directory), "ass=filename='x.ass'")
            files = sorted(path.name for path in Path(directory).iterdir())
        # 三个落点同一种头像：只准备一张 PNG、一个输入，用 split 复制。
        self.assertEqual(files, ["avatar-0.png"])
        self.assertEqual(inputs.count("-i"), 1)
        self.assertIn("split=3", graph)
        ass_at = graph.index("ass=filename='x.ass'")
        overlays = [index for index in range(len(graph)) if graph.startswith("overlay=", index)]
        self.assertEqual(len(overlays), 3)
        self.assertLess(overlays[1], ass_at, "text-behind avatars are overlaid before the subtitles")
        self.assertGreater(overlays[2], ass_at, "text-front avatars are overlaid after the subtitles")
        self.assertIn("enable='gte(t,1.000)*lt(t,2.000)'", graph)
        self.assertIn("fade=t=in:st=1.000:d=0.250:alpha=1", graph)
        self.assertIn("fade=t=out:st=1.750:d=0.250:alpha=1", graph)
        self.assertEqual(output, "[avatarout]")

    def test_single_frame_offset_shifts_avatar_streams(self) -> None:
        plan = parse_avatar_plan(_ass(["Avatar: 0,90000,av1,0,0,16,100,square,0,above,0,0,-"], {"av1": _png((0, 0, 255))}))
        with tempfile.TemporaryDirectory() as directory:
            _inputs, graph, _output = build_avatar_filter(plan, Path(directory), "ass=filename='f.ass'",
                                                          base_input="0:V:0", time_offset_ms=61_500, rgb_output=True)
        self.assertIn("setpts=PTS+61.500/TB", graph)
        self.assertIn("[0:V:0]format=rgb24[base]", graph)
        self.assertIn(":format=rgb:", graph)


@needs_pillow
class AvatarBurnTests(unittest.TestCase):
    def test_burn_command_is_unchanged_without_avatar_sections(self) -> None:
        captured: list[list[str]] = []
        with tempfile.TemporaryDirectory() as directory:
            subtitle = Path(directory) / "caption.ass"
            subtitle.write_text(_ass([], {}), encoding="utf-8")
            media = Path(directory) / "clip.mp4"
            media.write_bytes(b"")

            def fake_run(command, **_kwargs):
                captured.append(list(command))
                Path(command[-1]).write_bytes(b"x")

            with mock.patch("maw.postprocess_ffmpeg._run_ffmpeg_process", side_effect=fake_run), \
                    mock.patch("maw.postprocess_ffmpeg._video_encoder_attempts", return_value=("cpu",)), \
                    mock.patch("maw.postprocess_ffmpeg._validated_media_path", side_effect=lambda path, **_: path):
                run_burn_subtitles(BurnSubtitleRequest(media_path=media, subtitle_path=subtitle), ffmpeg_path=Path("ffmpeg"))
        command = captured[0]
        self.assertIn("-vf", command)
        self.assertNotIn("-filter_complex", command)
        self.assertEqual(command[command.index("-vf") + 1], "ass=filename='caption.ass'")

    def test_burn_reports_a_clear_error_when_avatar_preprocessing_is_unavailable(self) -> None:
        from maw.multiplayer_avatars import AvatarPlanError
        from maw.postprocess_ffmpeg import MediaToolError

        with tempfile.TemporaryDirectory() as directory:
            subtitle = Path(directory) / "caption.ass"
            subtitle.write_text(_ass(["Avatar: 0,1000,av1,0,0,16,100,circle,0,above,0,0,-"],
                                     {"av1": _png((1, 2, 3))}), encoding="utf-8")
            media = Path(directory) / "clip.mp4"
            media.write_bytes(b"")
            with mock.patch("maw.postprocess_ffmpeg.build_avatar_filter", side_effect=AvatarPlanError("头像烧录需要 Pillow")), \
                    mock.patch("maw.postprocess_ffmpeg._run_ffmpeg_process") as run, \
                    mock.patch("maw.postprocess_ffmpeg._validated_media_path", side_effect=lambda path, **_: path):
                with self.assertRaisesRegex(MediaToolError, "Pillow"):
                    run_burn_subtitles(BurnSubtitleRequest(media_path=media, subtitle_path=subtitle), ffmpeg_path=Path("ffmpeg"))
            run.assert_not_called()

    def test_real_ffmpeg_burn_overlays_avatars_only_inside_their_time_range(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("ffmpeg 不在 PATH 上，跳过真实烧录验证")
        filters = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        if " ass " not in filters:
            self.skipTest("ffmpeg 未编译 libass，跳过真实烧录验证")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "clip.mp4"
            subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", "color=c=black:s=320x180:r=25:d=2", "-pix_fmt", "yuv420p", str(media)], check=True)
            subtitle = root / "clip.ass"
            subtitle.write_text(_ass(["Avatar: 500,1500,av1,40,40,48,100,square,0,above,0,0,-"],
                                     {"av1": _png((255, 0, 0))}), encoding="utf-8")
            result = run_burn_subtitles(BurnSubtitleRequest(media_path=media, subtitle_path=subtitle, crf=10),
                                        ffmpeg_path=Path(ffmpeg))

            def pixel(at: float) -> tuple[int, int, int]:
                frame = root / f"frame-{at}.png"
                subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{at}", "-i",
                                str(result.media_path), "-frames:v", "1", str(frame)], check=True)
                return Image.open(frame).convert("RGB").getpixel((64, 64))

            inside = pixel(1.0)
            outside = pixel(1.8)
        self.assertGreater(inside[0], 180)
        self.assertLess(inside[1], 80)
        self.assertLess(max(outside), 40)


if __name__ == "__main__":
    unittest.main()
