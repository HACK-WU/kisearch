#!/usr/bin/env python3
"""ki-upload —— 把本地文档或整个目录上传到远端 ki（走 `/open/v1`，用 httpflex）。

为什么单独成脚本而不是每次现写代码：
  上传链路有三个容易写错的点（参数必须放 query、multipart 只能走构造参数、
  tar 要按 pax 打包并流式发送），现写一次错一次。

用法速览（详见 SKILL.md）：
  python scripts/ki_upload.py ping
  python scripts/ki_upload.py upload ./a.md ./sub/b.md --scope default --group wiki
  python scripts/ki_upload.py upload-dir ./docs --scope default
  python scripts/ki_upload.py status --task <taskId>

输出：stdout 一行 JSON（供 agent 解析），进度/告警走 stderr。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tarfile
import tempfile
import time
import urllib.parse
from pathlib import Path

try:
    from httpflex import BaseClient
except ImportError:  # pragma: no cover - 环境问题，直接给出路
    sys.stderr.write(
        "缺少依赖 httpflex（未发布到 PyPI，且不能装在系统 Python 上）。装法：\n"
        "  python3 -m venv .venv && . .venv/bin/activate\n"
        '  pip install "git+https://github.com/HACK-WU/httpflex.git"\n'
        "然后用该环境里的 python 重跑本脚本（常见原因：装了但用了另一个解释器）。\n"
    )
    raise SystemExit(2)

DEFAULT_EXTENSIONS = (".md", ".mdx")
# multipart 一次最多塞这么多文件：再多就该用 tar（服务端两分支落点一致，但 multipart 的
# 请求体是拼接生成的，几千个 part 对客户端和服务端都更脆）
MAX_MULTIPART_FILES = 300
POLL_INTERVAL_INITIAL = 1.0
POLL_INTERVAL_MAX = 5.0


class UploadError(Exception):
    """带阶段与错误码的可诊断失败（脚本据此决定退出码）。"""

    def __init__(self, stage: str, message: str, *, code: str | None = None, detail: dict | None = None):
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.detail = detail or {}


def log(message: str) -> None:
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def build_client(
    base_url: str,
    token: str,
    endpoint: str,
    *,
    method: str = "GET",
    timeout: float = 30,
    retry: bool = False,
    headers: dict[str, str] | None = None,
    extra: dict | None = None,
) -> BaseClient:
    """按需造一个一次性客户端。

    ★ 三个实测坑（务必保留）：
      1. `base_url` 必须是类属性；用构造参数 `url=` 再配 `endpoint` 会拼出非法 URL
         （实测报 `Invalid URL '/upload': No scheme supplied`）。
      2. `files=` / `data=` 只能作为**构造参数**透传（httpflex 没有对应的 request 形参），
         且绑定该实例的每一次请求 —— 所以一次上传一个客户端，用完 close。
      3. POST 的 `request_data` 会变成 JSON 请求体，所以 `/open/v1` 的参数只能拼在
         `endpoint` 的 query 上，请求数据一律传 `{}`。
    """

    class _Client(BaseClient):
        default_timeout = timeout
        enable_retry = retry
        max_retries = 2

    _Client.base_url = base_url
    _Client.endpoint = endpoint
    _Client.method = method
    kwargs: dict = {}
    if headers:
        kwargs["headers"] = headers
    if extra:
        kwargs.update(extra)
    return _Client(**kwargs)


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def call(client: BaseClient, payload: dict | None = None, *, probe=None) -> dict:
    """发一次请求并把 httpflex 的统一返回结构规整为 dict；失败抛 UploadError。

    ★ httpflex 0.1.1-beta 在 4xx/5xx 时**会丢掉响应体**（实测返回 `data: null`、
    `message: "HTTP 403: Forbidden"`），而 `/open/v1` 的可判别信息全在那份 JSON 里
    （`OPEN_API_TOKEN_READONLY` / `OPEN_API_SCOPE_FORBIDDEN` 出路完全不同）。
    所以 GET 类请求失败时用 `probe` 补读一次错误体；POST 失败不能重发（会重复上传），
    改由调用方传 `hint` 按状态码给出路。
    """
    try:
        result = client.request(payload or {})
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001 - close 失败不该覆盖真实错误
            pass
    if not isinstance(result, dict):
        raise UploadError("client", f"httpflex 返回了非字典结果：{result!r}")
    if result.get("result") is not True:
        status = result.get("code")
        message = str(result.get("message") or "").strip()
        api_code = None
        api_error = None
        if probe is not None:
            api_code, api_error = probe()
        raise UploadError(
            "http",
            api_error or _post_hint(status) or message or f"HTTP {status}",
            code=str(api_code or status),
        )
    return result.get("data") if isinstance(result.get("data"), dict) else {}


# POST 失败的「猜测式出路」：拿不到响应体时的兜底文案（每种原因的动作完全不同，
# 泛泛说「请求失败」等于没说）
_POST_STATUS_HINTS = {
    400: "请求被服务端拒绝（参数非法，或归档不安全/损坏）。用 curl 复现一次可拿到具体 OPEN_API_* 码",
    401: "Token 缺失或无效：核对 KI_TOKEN，先跑 ping 自检",
    403: "Token 只读 / 未授权该库 / 目标库被设为只读（三种出路不同，见 reference.md 错误码表）",
    404: "上传接口已关闭（--no-upload-api），或路径拼错",
    405: "方法不对（上传必须用 POST）",
    409: "服务端配置身份已漂移，重试无用，需重启 ki daemon",
    413: "超过单次请求上限：分批上传，或让运维调大 mcp.http.uploadMaxBytes",
    415: "Content-Type 不被接受（本脚本固定 multipart / application/gzip，除非被中间层改写）",
    503: "服务端暂不可写（任务记录或暂存目录异常），稍后重试",
}


def _post_hint(status) -> str | None:
    try:
        return _POST_STATUS_HINTS.get(int(status))
    except (TypeError, ValueError):
        return None


def make_get_probe(base: str, token: str, endpoint: str, timeout: float):
    """返回一个「补读错误体」的闭包。

    用 httpflex 的依赖 `requests` 再发一次 GET（不额外安装）：只有 GET 才这样做，
    因为重发 POST 会把文件再传一遍。
    """

    def probe() -> tuple[str | None, str | None]:
        try:
            import requests  # httpflex 的硬依赖，必装
        except ImportError:  # pragma: no cover
            return None, None
        try:
            resp = requests.get(f"{base}{endpoint}", headers=auth_headers(token), timeout=timeout)
            if resp.status_code < 400:
                return None, None
            try:
                body = resp.json()
            except ValueError:
                return None, resp.text[:200] or None
            if isinstance(body, dict):
                return body.get("code"), body.get("error")
        except Exception:  # noqa: BLE001 - 补读失败就退回原错误
            return None, None
        return None, None

    return probe


def require_env(args) -> tuple[str, str]:
    base = (args.url or os.environ.get("KI_URL") or "").rstrip("/")
    token = args.token or os.environ.get("KI_TOKEN") or ""
    if not base:
        raise UploadError("config", "未指定服务地址：用 --url 或环境变量 KI_URL（如 http://10.0.0.5:7423）")
    if not token:
        raise UploadError("config", "未指定 Token：用 --token 或环境变量 KI_TOKEN（在 ki 所在机器执行 ki mcp token generate --scope <库名>）")
    if not base.startswith(("http://", "https://")):
        base = "http://" + base
    return base, token


def cmd_ping(args) -> dict:
    base, token = require_env(args)
    query = f"?scope={urllib.parse.quote(args.scope)}" if args.scope else ""
    endpoint = f"/open/v1/ping{query}"
    payload = call(
        build_client(base, token, endpoint, timeout=args.timeout, retry=True, headers=auth_headers(token)),
        probe=make_get_probe(base, token, endpoint, args.timeout),
    )
    return {"ok": True, "server": base, "ping": payload}


def cmd_status(args) -> dict:
    base, token = require_env(args)
    endpoint = f"/open/v1/import/status?taskId={urllib.parse.quote(args.task)}"
    payload = call(
        build_client(base, token, endpoint, timeout=args.timeout, retry=True, headers=auth_headers(token)),
        probe=make_get_probe(base, token, endpoint, args.timeout),
    )
    return {"ok": True, "taskId": args.task, "status": payload}


def wait_for_task(base: str, token: str, task_id: str, timeout: float) -> dict:
    """轮询到终态。把 queued/waiting 说清楚，避免把「排队」误判成「卡住」。"""
    deadline = time.time() + timeout
    interval = POLL_INTERVAL_INITIAL
    last_line = ""
    while True:
        endpoint = f"/open/v1/import/status?taskId={urllib.parse.quote(task_id)}"
        status = call(
            build_client(base, token, endpoint, timeout=30, retry=True, headers=auth_headers(token)),
            probe=make_get_probe(base, token, endpoint, 30),
        )
        state = status.get("state")
        phase = status.get("phase") or "-"
        progress = status.get("progress")
        line = f"[{state}/{phase}] progress={progress} waiting_lock={status.get('waitingForScopeLock')}"
        if line != last_line:
            log(line)
            last_line = line
        if state in {"done", "failed", "cancelled"}:
            return status
        if time.time() > deadline:
            raise UploadError(
                "wait",
                f"等待导入超时（{int(timeout)}s）。任务仍在后台运行，可稍后用 status 查询：taskId={task_id}",
                code="WAIT_TIMEOUT",
                detail={"taskId": task_id},
            )
        time.sleep(interval)
        interval = min(interval * 1.5, POLL_INTERVAL_MAX)


def build_query(args, *, archive: bool) -> str:
    params: dict[str, str] = {"scope": args.scope}
    if args.group:
        params["group"] = args.group
    if args.tags:
        params["tags"] = args.tags
    params["vector"] = "0" if args.no_vector else "1"
    if args.conflict_mode:
        params["conflictMode"] = args.conflict_mode
    if args.chunk_size is not None:
        params["chunkSize"] = str(args.chunk_size)
    if args.chunk_overlap is not None:
        params["chunkOverlap"] = str(args.chunk_overlap)
    if archive:
        params["archive"] = "tar.gz"
    return "?" + urllib.parse.urlencode(params)


def precheck_limits(base: str, token: str, total_bytes: int, largest: tuple[str, int], args) -> dict:
    """上传前先自检：把「1MB 单文件上限」这类必然失败挡在本地，别白传一遍。"""
    endpoint = f"/open/v1/ping?scope={urllib.parse.quote(args.scope)}"
    ping = call(
        build_client(base, token, endpoint, timeout=30, retry=True, headers=auth_headers(token)),
        probe=make_get_probe(base, token, endpoint, 30),
    )
    limits = ping.get("limits") or {}
    max_file = int(limits.get("maxFileSize") or 0)
    max_body = int(limits.get("maxRequestBody") or 0)
    if max_body and total_bytes > max_body:
        raise UploadError(
            "precheck",
            f"本次要传 {total_bytes} 字节，超过服务端单次请求上限 {max_body} 字节。"
            "改小批次，或让运维调大 mcp.http.uploadMaxBytes",
            code="OPEN_API_PAYLOAD_TOO_LARGE",
        )
    if max_file and largest[1] > max_file and not args.allow_oversize:
        raise UploadError(
            "precheck",
            f"文件 {largest[0]} 有 {largest[1]} 字节，超过服务端单文件上限 {max_file} 字节（服务端会直接跳过它）。"
            "让运维调大 scopes.<库名>.import.maxFileSize，或加 --allow-oversize 强行上传（该文件会被跳过）",
            code="FILE_TOO_LARGE_PREFLIGHT",
        )
    return limits


def cmd_upload(args) -> dict:
    base, token = require_env(args)
    paths = [Path(p) for p in args.paths]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise UploadError("input", f"不是文件（目录请用 upload-dir）：{', '.join(missing)}")
    if len(paths) > MAX_MULTIPART_FILES:
        raise UploadError(
            "input",
            f"一次最多 {MAX_MULTIPART_FILES} 个文件（当前 {len(paths)}）。文件再多请用 upload-dir，它会打成一个 tar 包",
        )

    total = sum(p.stat().st_size for p in paths)
    largest = max(((str(p), p.stat().st_size) for p in paths), key=lambda x: x[1])
    if not args.no_precheck:
        precheck_limits(base, token, total, largest, args)
        log(f"precheck ok：{len(paths)} 个文件 / {total} 字节")

    # 相对路径 = 传入时的目录结构（保持层级靠 filename 里的相对路径）
    rel_names = [_rel_name(p, paths) for p in paths]
    handles = []
    files = []
    try:
        for path, rel in zip(paths, rel_names):
            fh = open(path, "rb")
            handles.append(fh)
            files.append(("files", (rel, fh, "text/markdown")))
        client = build_client(
            base,
            token,
            f"/open/v1/import/upload{build_query(args, archive=False)}",
            method="POST",
            timeout=args.timeout * 4,  # 上传耗时远大于普通请求
            retry=False,  # POST 不重试：重传整包比失败更糟（会产生重复流量）
            headers=auth_headers(token),
            extra={"files": files},
        )
        uploaded = call(client)
    finally:
        for fh in handles:
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass
    return finish(args, base, token, uploaded, mode="multipart")


def cmd_upload_dir(args) -> dict:
    base, token = require_env(args)
    root = Path(args.dir).resolve()
    if not root.is_dir():
        raise UploadError("input", f"不是目录：{root}")

    files = _collect_files(root, args)
    if not files:
        raise UploadError("input", f"目录里没有可上传的文件（扩展名白名单：{', '.join(args.include_ext)}；用 --all-files 放开）")
    if len(files) > args.max_files:
        raise UploadError("input", f"文件数 {len(files)} 超过本次上限 {args.max_files}（服务端单批默认上限 20000）")

    total = sum(p.stat().st_size for p in files)
    largest = max(((str(p.relative_to(root)), p.stat().st_size) for p in files), key=lambda x: x[1])
    if not args.no_precheck:
        precheck_limits(base, token, total, largest, args)
        log(f"precheck ok：{len(files)} 个文件 / {total} 字节")

    tmp = _make_tar(root, files)
    try:
        log(f"已打包 {len(files)} 个文件 → {tmp}（{tmp.stat().st_size} 字节，发送中…）")
        fh = open(tmp, "rb")
        try:
            client = build_client(
                base,
                token,
                f"/open/v1/import/upload{build_query(args, archive=True)}",
                method="POST",
                timeout=args.timeout * 8,
                retry=False,
                headers={**auth_headers(token), "Content-Type": "application/gzip"},
                extra={"data": fh},
            )
            uploaded = call(client)
        finally:
            fh.close()
    finally:
        try:
            tmp.unlink()
        except OSError:
            log(f"警告：临时包未删除，可手动清理 {tmp}")
    return finish(args, base, token, uploaded, mode="tar.gz")


def finish(args, base: str, token: str, uploaded: dict, *, mode: str) -> dict:
    task_id = uploaded.get("taskId")
    if not task_id:
        raise UploadError("upload", "服务端未返回 taskId（响应异常）", code="NO_TASK_ID", detail={"response": uploaded})
    files = uploaded.get("files") or {}
    log(f"上传完成（{mode}）：saved={files.get('saved')} skipped={files.get('skipped')} taskId={task_id}")
    for item in (files.get("skippedSample") or [])[:5]:
        log(f"  跳过：{item.get('rel')} —— {item.get('reason')}")
    out = {
        "ok": True,
        "mode": mode,
        "taskId": task_id,
        "uploadId": uploaded.get("uploadId"),
        "scope": uploaded.get("scope"),
        "group": uploaded.get("group"),
        "files": files,
        "totalBytes": uploaded.get("totalBytes"),
        "import": None,
    }
    if args.wait:
        status = wait_for_task(base, token, task_id, args.wait_timeout)
        out["import"] = status
        if status.get("state") != "done":
            raise UploadError(
                "import",
                f"导入未成功：state={status.get('state')}"
                + (f"，error={status.get('error')}" if status.get("error") else ""),
                code=status.get("errorCode") or "IMPORT_FAILED",
                detail={"taskId": task_id, "status": status},
            )
    return out


def _collect_files(root: Path, args) -> list[Path]:
    exts = tuple(e.lower() if e.startswith(".") else "." + e.lower() for e in args.include_ext)
    picked: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.is_symlink():
            continue  # 服务端会拒收链接条目，本地直接不打包
        name = path.name
        if name.startswith("."):
            continue
        if args.all_files or path.suffix.lower() in exts:
            picked.append(path)
    return picked


def _make_tar(root: Path, files: list[Path]) -> Path:
    """按 pax 格式打包：GNU 默认格式在 Windows 上会让中文条目名变异，pax 两种实现都能读。"""
    fd, name = tempfile.mkstemp(prefix="ki-upload-", suffix=".tar.gz")
    os.close(fd)
    out = Path(name)
    with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for path in files:
            tar.add(path, arcname=str(path.relative_to(root)).replace(os.sep, "/"))
    return out


def _rel_name(path: Path, all_paths: list[Path]) -> str:
    """多个文件时尽量保留相对目录（同一父目录下则用文件名）。"""
    parents = {p.parent for p in all_paths}
    if len(parents) == 1:
        return path.name
    common = os.path.commonpath([str(p.parent) for p in all_paths])
    return str(path.resolve().relative_to(common)).replace(os.sep, "/")


def add_common(parser: argparse.ArgumentParser, *, allow_after_subcommand: bool) -> None:
    """把公共参数挂到解析器上。

    `allow_after_subcommand=True` 时用 `default=SUPPRESS`：让子命令也能接受
    `... upload a.md --scope prod` 这种写法，且**不会**用默认值覆盖用户在子命令前
    已经给出的值（argparse 的经典坑：子解析器再写一遍默认值会把父级结果冲掉）。
    """
    kw = {"default": argparse.SUPPRESS} if allow_after_subcommand else {}
    parser.add_argument("--url", **{**kw, "help": "服务地址，如 http://10.0.0.5:7423（或环境变量 KI_URL）"})
    parser.add_argument("--token", **{**kw, "help": "Bearer Token（或环境变量 KI_TOKEN）"})
    parser.add_argument("--scope", **{**kw, "help": "目标库名（默认 default）"})
    parser.add_argument("--timeout", type=float, **{**kw, "help": "单次请求超时秒数（默认 30）"})


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ki_upload", description="把本地文档/目录上传到远端 ki（/open/v1）")
    add_common(parser, allow_after_subcommand=False)
    parser.set_defaults(url=None, token=None, scope="default", timeout=30.0)
    sub = parser.add_subparsers(dest="command", required=True)

    p_ping = sub.add_parser("ping", help="连通性 / Token / 上限自检")
    add_common(p_ping, allow_after_subcommand=True)
    p_ping.set_defaults(func=cmd_ping)

    def add_upload_opts(p):
        p.add_argument("--group", help="落点目录（留空则由文件所在子目录推导）")
        p.add_argument("--tags", help="逗号分隔的自定义标签")
        p.add_argument("--no-vector", action="store_true", help="只建全文索引，不做向量化（等价 ki import --no-vector）")
        p.add_argument("--conflict-mode", choices=["incremental", "overwrite", "skip", "suffix"], help="同名文档策略（默认 incremental）")
        p.add_argument("--chunk-size", type=int, help="切分长度 100–4000")
        p.add_argument("--chunk-overlap", type=int, help="切分重叠 0–500，须小于 chunk-size")
        p.add_argument("--wait", dest="wait", action="store_true", default=True, help="等待导入完成（默认开启）")
        p.add_argument("--no-wait", dest="wait", action="store_false", help="只上传，不等导入结果")
        p.add_argument("--wait-timeout", type=float, default=900, help="等待导入的上限秒数（默认 900）")
        p.add_argument("--no-precheck", action="store_true", help="跳过上传前的 ping 与体积预检")
        p.add_argument("--allow-oversize", action="store_true", help="明知超过单文件上限仍上传（服务端会跳过该文件）")

    p_up = sub.add_parser("upload", help="上传一组文件（multipart）")
    p_up.add_argument("paths", nargs="+", help="文件路径（目录请用 upload-dir）")
    add_upload_opts(p_up)
    add_common(p_up, allow_after_subcommand=True)
    p_up.set_defaults(func=cmd_upload)

    p_dir = sub.add_parser("upload-dir", help="上传整个目录（打成 tar.gz）")
    p_dir.add_argument("dir", help="目录路径（打包根 = 知识库根）")
    p_dir.add_argument("--include-ext", nargs="+", default=list(DEFAULT_EXTENSIONS), help="打包的扩展名白名单（默认 .md .mdx）")
    p_dir.add_argument("--all-files", action="store_true", help="不按扩展名过滤，全部打包（服务端仍会跳过非文档）")
    p_dir.add_argument("--max-files", type=int, default=20000, help="本地文件数上限（默认 20000，与服务端单批上限一致）")
    add_upload_opts(p_dir)
    add_common(p_dir, allow_after_subcommand=True)
    p_dir.set_defaults(func=cmd_upload_dir)

    p_status = sub.add_parser("status", help="查指定 taskId 的进度/结果")
    p_status.add_argument("--task", required=True, help="上传返回的 taskId")
    add_common(p_status, allow_after_subcommand=True)
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    try:
        out = args.func(args)
    except UploadError as err:
        payload = {"ok": False, "stage": err.stage, **({"code": err.code} if err.code else {}), "error": str(err), **err.detail}
        print(json.dumps(payload, ensure_ascii=False))
        log(f"失败（{err.stage}）：{err}")
        return 3 if err.stage in {"upload", "http", "precheck", "import"} else 2
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
