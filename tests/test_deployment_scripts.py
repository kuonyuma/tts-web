"""Exercise deployment artifacts without user credentials or real process kills."""

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("docker") is None, reason="Docker CLI is unavailable")
def test_compose_passes_secret_files_and_read_only_directory(tmp_path):
    empty_env = tmp_path / "empty.env"
    empty_env.write_text("", encoding="utf-8")
    secret_dir = tmp_path / "fixture-secrets"
    secret_dir.mkdir()
    names = ("DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "QWEN_API_KEY", "AUTH_PROXY_SECRET")
    env = os.environ.copy()
    env.update({"APP_ENV": "development", "COPILOT_AUTH_MODE": "development",
                "TTS_SECRETS_DIR": str(secret_dir)})
    # Prevent local environment credentials from appearing in rendered config.
    for name in (*names, "GEMINI_API_KEY", "SERVER_KEY_ACCESS_TOKEN", "REDIS_URL"):
        env[name] = ""
    for name in names:
        env[f"{name}_FILE"] = f"/run/secrets/{name.lower()}"
    result = subprocess.run(
        ["docker", "compose", "--env-file", str(empty_env), "-f",
         str(ROOT / "docker-compose.yml"), "config", "--format", "json"],
        env=env, capture_output=True, text=True, check=True, timeout=30,
    )
    service = json.loads(result.stdout)["services"]["tts-web"]
    for name in names:
        assert service["environment"].get(f"{name}_FILE") == f"/run/secrets/{name.lower()}"
    mounts = [v for v in service["volumes"] if v["target"] == "/run/secrets"]
    assert len(mounts) == 1
    assert Path(mounts[0]["source"]).resolve() == secret_dir.resolve()
    assert mounts[0]["read_only"] is True


@pytest.mark.skipif(os.name != "nt", reason="CMD batch syntax requires Windows")
@pytest.mark.parametrize("listening_port, expected_pid", [(8000, "43210"), (9001, None), (80000, None)])
def test_stop_batch_parses_listening_pid_in_cmd(tmp_path, listening_port, expected_pid):
    script = tmp_path / "stop.bat"
    script.write_bytes((ROOT / "stop.bat").read_bytes())
    (tmp_path / "netstat.cmd").write_text(
        f"@echo off\necho   TCP    127.0.0.1:{listening_port}    0.0.0.0:0    LISTENING    43210\n"
        "echo   TCP    127.0.0.1:9000    0.0.0.0:0    LISTENING    43211\n",
        encoding="ascii",
    )
    # Resolution in this fixture directory shadows the real taskkill executable.
    (tmp_path / "taskkill.cmd").write_text(
        '@echo off\necho %*>>"%~dp0killed.txt"\n', encoding="ascii",
    )
    # CMD's interactive pause rejects redirected stdin used by the test harness.
    (tmp_path / "timeout.cmd").write_text("@exit /b 0\n", encoding="ascii")
    (tmp_path / "pwsh.cmd").write_text("@exit /b 0\n", encoding="ascii")
    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env["PATH"]
    result = subprocess.run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(script)],
        cwd=tmp_path, env=env, capture_output=True, timeout=15,
    )
    killed = tmp_path / "killed.txt"
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    if expected_pid is None:
        assert not killed.exists()
    else:
        assert killed.exists(), result.stderr.decode(errors="replace")
        assert killed.read_text(encoding="ascii").strip() == f"/f /pid {expected_pid}"


@pytest.mark.skipif(os.name != "nt", reason="CMD batch syntax requires Windows")
def test_stop_batch_preserves_an_unrelated_listener(tmp_path):
    (tmp_path / "stop.bat").write_bytes((ROOT / "stop.bat").read_bytes())
    (tmp_path / "netstat.cmd").write_text(
        "@echo off\necho TCP 127.0.0.1:8000 0.0.0.0:0 LISTENING 43210\n", encoding="ascii",
    )
    (tmp_path / "pwsh.cmd").write_text("@exit /b 1\n", encoding="ascii")
    (tmp_path / "timeout.cmd").write_text("@exit /b 0\n", encoding="ascii")
    (tmp_path / "taskkill.cmd").write_text('@echo invoked>"%~dp0killed.txt"\n', encoding="ascii")
    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env["PATH"]
    subprocess.run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(tmp_path / "stop.bat")],
        cwd=tmp_path, env=env, capture_output=True, timeout=15,
    )
    assert not (tmp_path / "killed.txt").exists()


@pytest.mark.skipif(os.name != "nt", reason="CMD batch syntax requires Windows")
@pytest.mark.parametrize("kill_exit", [0, 1])
def test_stop_batch_deduplicates_pid_and_reports_failure(tmp_path, kill_exit):
    (tmp_path / "stop.bat").write_bytes((ROOT / "stop.bat").read_bytes())
    (tmp_path / "netstat.cmd").write_text(
        "@echo off\necho TCP 127.0.0.1:8000 0.0.0.0:0 LISTENING 43210\n"
        "echo TCP [::1]:8000 [::]:0 LISTENING 43210\n", encoding="ascii",
    )
    (tmp_path / "pwsh.cmd").write_text("@exit /b 0\n", encoding="ascii")
    (tmp_path / "timeout.cmd").write_text("@exit /b 0\n", encoding="ascii")
    (tmp_path / "taskkill.cmd").write_text(
        f'@echo off\necho %*>>"%~dp0killed.txt"\nexit /b {kill_exit}\n', encoding="ascii",
    )
    result = subprocess.run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(tmp_path / "stop.bat")],
        cwd=tmp_path, capture_output=True, timeout=15,
    )
    assert result.returncode == kill_exit, result.stderr.decode(errors="replace")
    assert (tmp_path / "killed.txt").read_text(encoding="ascii").splitlines() == ["/f /pid 43210"]


@pytest.mark.skipif(os.name != "nt" or shutil.which("pwsh") is None,
                    reason="Windows process identity check requires PowerShell 7")
@pytest.mark.parametrize("case, expected_exit", [
    ("owned", 0), ("owned_launcher", 0), ("other_python", 1),
    ("other_app_dir", 1), ("other_app", 1), ("missing", 1),
])
def test_stop_process_identity_check(tmp_path, case, expected_exit):
    executable = ROOT / ".venv" / "Scripts" / "python.exe"
    source = ROOT / "src"
    if case == "owned_launcher":
        executable = ROOT / ".venv" / "Scripts" / "uvicorn.exe"
    if case == "other_python":
        executable = tmp_path / "other" / "python.exe"
    if case == "other_app_dir":
        source = tmp_path / "other" / "src"
    application = "app.main:app" if case != "other_app" else "other.main:app"
    process = None if case == "missing" else {
        "ExecutablePath": str(executable),
        "CommandLine": (f'"{executable}" {application} --app-dir "{source}" --port 8000'
                        if case == "owned_launcher" else
                        f'"{executable}" -m uvicorn {application} --app-dir "{source}" --port 8000'),
    }
    fixture = tmp_path / "process.json"
    fixture.write_text(json.dumps(process), encoding="utf-8")
    wrapper = tmp_path / "verify.ps1"
    wrapper.write_text(
        "param($Fixture, $Verifier, $Project)\n"
        "$ErrorActionPreference = 'Stop'\n"
        "$global:ttsFixtureProcess = Get-Content -LiteralPath $Fixture -Raw | ConvertFrom-Json\n"
        "function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) $global:ttsFixtureProcess }\n"
        "& $Verifier -ProcessId 43210 -ProjectRoot $Project\n"
        "exit $LASTEXITCODE\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        ["pwsh", "-NoProfile", "-File", str(wrapper), str(fixture),
         str(ROOT / "scripts" / "verify_tts_process.ps1"), str(ROOT)],
        capture_output=True, timeout=15,
    )
    assert result.returncode == expected_exit, result.stderr.decode(errors="replace")
