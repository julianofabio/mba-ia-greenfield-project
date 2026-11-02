"""Client-side upload of a (large) video through the StreamTube API — runs on the HOST.

Same flow a frontend would use: POST /videos (draft) → presigned part URLs →
PUT each 64 MiB part straight to object storage (in parallel) → complete →
poll until the worker marks the video ready/failed. No video byte goes through
the API. Re-running with --resume <video-id> uploads only the missing parts.

Usage:
  python scripts/upload-video.py <file> --create-user
  python scripts/upload-video.py <file> --email a@b.com --password secret123
  python scripts/upload-video.py <file> --email a@b.com --password secret123 --resume <video-id>
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

COMPOSE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PART_URLS_PER_REQUEST = 100


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def http(method, url, body=None, token=None, data=None, timeout=600):
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with OPENER.open(req, timeout=timeout) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def api(args, method, path, body=None, token=None, expect=(200,)):
    status, headers, raw = http(method, args.api + path, body, token)
    if status not in expect:
        sys.exit(f"{method} {path} -> {status}: {raw.decode(errors='replace')}")
    return json.loads(raw) if raw else None, headers


def login(args):
    if args.create_user:
        args.email = f"upload_{uuid.uuid4().hex[:8]}@example.com"
        args.password = "password123"
        api(args, "POST", "/auth/register", {"email": args.email, "password": args.password}, expect=(201,))
        # Dev shortcut: confirm the account directly (no mailbox round-trip).
        subprocess.run(
            ["docker", "compose", "exec", "-T", "db", "psql", "-U", "streamtube", "-d", "streamtube",
             "-c", f"UPDATE users SET is_confirmed = true WHERE email = '{args.email}'"],
            cwd=COMPOSE_DIR, check=True, capture_output=True,
        )
        print(f"user: {args.email} / {args.password}")
    body, _ = api(args, "POST", "/auth/login", {"email": args.email, "password": args.password})
    return body["access_token"]


def human(n):
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file")
    parser.add_argument("--api", default=os.environ.get("API_URL", "http://localhost:3010"))
    parser.add_argument("--email")
    parser.add_argument("--password")
    parser.add_argument("--create-user", action="store_true")
    parser.add_argument("--resume", metavar="VIDEO_ID")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--content-type", default="video/mp4")
    parser.add_argument("--no-wait", action="store_true", help="do not wait for processing")
    args = parser.parse_args()
    if not args.create_user and not (args.email and args.password):
        parser.error("use --create-user or --email/--password")

    size = os.path.getsize(args.file)
    token = login(args)

    if args.resume:
        video_id = args.resume
        state, _ = api(args, "GET", f"/videos/{video_id}/upload", token=token)
        part_size, part_count = state["part_size"], state["part_count"]
        done = {p["part_number"] for p in state["uploaded_parts"]}
        print(f"resuming {video_id}: {len(done)}/{part_count} parts already stored")
    else:
        started = time.time()
        video, _ = api(args, "POST", "/videos", {
            "file_name": os.path.basename(args.file),
            "file_size": size,
            "content_type": args.content_type,
        }, token, expect=(201,))
        video_id, part_size, part_count = video["id"], video["part_size"], video["part_count"]
        done = set()
        print(f"draft {video_id} (public_id {video['public_id']}) — {human(size)} in {part_count} parts "
              f"of {human(part_size)} [POST /videos took {time.time() - started:.2f}s]")

    missing = [n for n in range(1, part_count + 1) if n not in done]
    sent = sum(min(part_size, size - (n - 1) * part_size) for n in done)
    lock = threading.Lock()
    t0 = time.time()

    def upload_part(number, url):
        nonlocal sent
        offset = (number - 1) * part_size
        length = min(part_size, size - offset)
        with open(args.file, "rb") as fh:
            fh.seek(offset)
            chunk = fh.read(length)
        status, _, raw = http("PUT", url, data=chunk)
        if status != 200:
            raise RuntimeError(f"part {number}: storage answered {status} {raw[:200]!r}")
        with lock:
            sent += length
            rate = (sent - (size - sum(min(part_size, size - (n - 1) * part_size) for n in missing))) / max(time.time() - t0, 1e-6)
            print(f"\r  {sent / size * 100:5.1f}%  {human(sent)}/{human(size)}  {human(rate)}/s   ", end="", flush=True)

    for i in range(0, len(missing), PART_URLS_PER_REQUEST):
        batch = missing[i:i + PART_URLS_PER_REQUEST]
        signed, _ = api(args, "POST", f"/videos/{video_id}/upload/part-urls", {"part_numbers": batch}, token)
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(upload_part, p["part_number"], p["url"]) for p in signed["parts"]]
            for future in as_completed(futures):
                future.result()
    print(f"\nupload finished in {time.time() - t0:.0f}s")

    completed, _ = api(args, "POST", f"/videos/{video_id}/upload/complete", token=token, expect=(202,))
    print(f"complete -> {completed['status']} (size_bytes={completed['size_bytes']})")
    if args.no_wait:
        return

    t1 = time.time()
    while True:
        video, _ = api(args, "GET", f"/videos/{video_id}", token=token)
        if video["status"] in ("ready", "failed"):
            break
        time.sleep(3)
    print(f"processing -> {video['status']} after {time.time() - t1:.0f}s")
    print(json.dumps({k: video[k] for k in (
        "id", "public_id", "duration_seconds", "width", "height", "video_codec",
        "audio_codec", "size_bytes", "thumbnail_url", "failure_reason")}, indent=2))
    if video["status"] == "ready":
        print(f"stream:   {args.api}/videos/{video['public_id']}/stream")
        print(f"download: {args.api}/videos/{video['public_id']}/download")


if __name__ == "__main__":
    main()
