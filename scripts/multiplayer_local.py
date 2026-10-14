"""[multiplayer] MAW Multiplayer 本地一键启动助手（由仓库根目录的 MAW-Multiplayer.bat 调用）。

检查并准备运行环境（Python 虚拟环境、Node 依赖、FFmpeg），再启动编辑器或 Launcher。
只用标准库，可在 .venv 尚未创建时运行。用法：

    MAW-Multiplayer.bat                 交互菜单
    MAW-Multiplayer.bat 工程.mosp        直接用编辑器打开该工程（也可把工程拖到 bat 上）
    MAW-Multiplayer.bat editor|resume|launcher|update|test|doctor
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV_PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
WINGET_LINKS = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links"
PROJECT_SUFFIXES = {".mosp", ".json"}
MULTIPLAYER_TESTS_JS = ["tests/test_multiplayer_data.mjs", "tests/test_multiplayer_ass.mjs", "tests/test_multiplayer_layout.mjs"]
MULTIPLAYER_TESTS_PY = ["tests/test_multiplayer_project.py", "tests/test_multiplayer_avatars.py"]


def say(message: str = "") -> None:
    print(message, flush=True)


def child_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    # winget 安装 FFmpeg 后，已打开的窗口不会自动刷新 PATH；这里补上它的链接目录。
    if WINGET_LINKS.is_dir() and str(WINGET_LINKS).lower() not in env.get("PATH", "").lower():
        env["PATH"] = f"{WINGET_LINKS}{os.pathsep}{env.get('PATH', '')}"
    return env


def which(name: str) -> str | None:
    return shutil.which(name, path=child_env()["PATH"])


def run(command: list[str], *, check: bool = True) -> int:
    say(f"> {' '.join(command)}")
    result = subprocess.run(command, cwd=ROOT, env=child_env())
    if check and result.returncode != 0:
        raise SystemExit(f"命令失败（退出码 {result.returncode}）：{' '.join(command)}")
    return result.returncode


def uv_command() -> list[str]:
    if which("uv"):
        return ["uv"]
    probe = subprocess.run([sys.executable, "-m", "uv", "--version"], capture_output=True, text=True)
    if probe.returncode == 0:
        return [sys.executable, "-m", "uv"]
    say("未找到 uv，正在为当前 Python 安装 uv（pip install --user uv）…")
    run([sys.executable, "-m", "pip", "install", "--user", "--quiet", "uv"])
    return [sys.executable, "-m", "uv"]


def sync_python(force: bool = False) -> None:
    if VENV_PYTHON.is_file() and not force:
        return
    say("准备 Python 虚拟环境（uv sync）…")
    env_python = os.environ.get("UV_PYTHON") or sys.executable
    # 仓库 .python-version 固定 3.11；直接使用当前 Python（≥3.11）可避免额外下载解释器。
    os.environ["UV_PYTHON"] = env_python
    run([*uv_command(), "sync"])


def sync_node(force: bool = False) -> None:
    if (ROOT / "node_modules").is_dir() and not force:
        return
    pnpm = which("pnpm")
    if not pnpm:
        if which("corepack"):
            run([which("corepack"), "enable"], check=False)
            pnpm = which("pnpm")
    if not pnpm:
        raise SystemExit("未找到 pnpm。请先安装 Node.js 22.13+，再运行：npm install -g pnpm")
    say("安装前端依赖并构建编辑器（pnpm install）…")
    run([pnpm, "install", "--frozen-lockfile"])


def ensure_ready() -> None:
    if sys.version_info < (3, 11):
        raise SystemExit(f"需要 Python 3.11 或更高版本，当前为 {sys.version.split()[0]}")
    if not which("node"):
        raise SystemExit("未找到 Node.js。请安装 Node.js 22.13 或更高版本后重试。")
    sync_python()
    sync_node()
    if not which("ffmpeg"):
        say("提示：未找到 FFmpeg。波形、实际画面预览与烧录需要它，可运行：winget install Gyan.FFmpeg")


def doctor() -> None:
    def status(label: str, ok: bool, detail: str = "") -> None:
        say(f"  [{'OK' if ok else '缺失'}] {label}{('：' + detail) if detail else ''}")

    say("运行环境检查：")
    status("Python", sys.version_info >= (3, 11), sys.version.split()[0])
    status("虚拟环境 .venv", VENV_PYTHON.is_file(), str(VENV_PYTHON))
    status("Node.js", bool(which("node")), which("node") or "")
    status("pnpm", bool(which("pnpm")), which("pnpm") or "")
    status("前端依赖 node_modules", (ROOT / "node_modules").is_dir())
    ffmpeg = which("ffmpeg")
    status("FFmpeg", bool(ffmpeg), ffmpeg or "winget install Gyan.FFmpeg")
    if ffmpeg:
        filters = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        status("FFmpeg libass（ASS 渲染 / 烧录）", " ass " in filters)
    if VENV_PYTHON.is_file():
        pillow = subprocess.run([str(VENV_PYTHON), "-c", "import PIL"], capture_output=True).returncode == 0
        status("Pillow（头像烧录）", pillow, "" if pillow else "运行 update 重新同步依赖")


def start_editor(project: Path | None = None, *, resume: bool = False) -> None:
    ensure_ready()
    command = [str(VENV_PYTHON), "server-editor/serve.py"]
    if project is not None:
        command.append(str(project))
    elif not resume:
        command.append("--blank")
    say("启动编辑器：浏览器会自动打开；关闭本窗口或按 Ctrl+C 停止。")
    run(command, check=False)


def start_launcher() -> None:
    ensure_ready()
    say("启动 Launcher：关闭 Launcher 窗口即退出。")
    run([str(VENV_PYTHON), "maw_gui.py"], check=False)


def update() -> None:
    if not which("node"):
        raise SystemExit("未找到 Node.js。请安装 Node.js 22.13 或更高版本后重试。")
    sync_python(force=True)
    sync_node(force=True)
    say("依赖已更新。")


def test() -> None:
    ensure_ready()
    run([which("node") or "node", "--test", *MULTIPLAYER_TESTS_JS], check=False)
    run([str(VENV_PYTHON), "scripts/run_tests.py", *MULTIPLAYER_TESTS_PY], check=False)


def menu() -> None:
    options = {
        "1": ("打开编辑器（空白，在页面里打开工程）", lambda: start_editor()),
        "2": ("打开编辑器并恢复上次的工程", lambda: start_editor(resume=True)),
        "3": ("打开 Launcher（转写、工具箱、烧录字幕）", start_launcher),
        "4": ("更新依赖（拉取新代码后用）", update),
        "5": ("运行多人模式测试", test),
        "6": ("检查运行环境", doctor),
    }
    say("MAW Multiplayer（MAW 联机版）")
    for key, (label, _action) in options.items():
        say(f"  {key}. {label}")
    say("  0. 退出")
    choice = input("请选择：").strip()
    if choice not in options:
        return
    options[choice][1]()
    # 双击运行时窗口会在脚本结束后关闭；停一下，方便查看输出。
    input("\n按回车键关闭…")


def main(argv: list[str]) -> None:
    os.chdir(ROOT)
    if not argv:
        menu()
        return
    first = argv[0]
    candidate = Path(first)
    if candidate.suffix.lower() in PROJECT_SUFFIXES and candidate.is_file():
        start_editor(candidate.resolve())
        return
    commands = {"editor": start_editor, "resume": lambda: start_editor(resume=True), "launcher": start_launcher,
                "update": update, "test": test, "doctor": doctor}
    if first not in commands:
        raise SystemExit(f"未知参数：{first}。可用：{', '.join(commands)}，或传入 .mosp / .json 工程路径")
    commands[first]()


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        say("\n已停止。")
