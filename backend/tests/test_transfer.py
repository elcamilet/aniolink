import hashlib
import json
import re
import threading
import time
from urllib.parse import urlparse

import httpx
from websockets.sync.client import connect


def create_token(client: httpx.Client) -> str:
    response = client.get("/token")
    assert response.status_code == 200
    match = re.search(r"TOKEN: (\w+)", response.text)
    assert match, response.text
    return match.group(1)


def wait_for_upload(client: httpx.Client, token: str, filename: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/{token}/info")
        if response.status_code == 200 and response.json().get("filename") == filename:
            return
        time.sleep(0.05)
    raise AssertionError(f"La subida de {filename} no se registró a tiempo")


def _put_bytes(base_url: str, token: str, filename: str, data: bytes, result: dict) -> None:
    try:
        with httpx.Client(base_url=base_url, timeout=60) as client:
            response = client.put(
                f"/{token}/{filename}",
                content=data,
                headers={"Content-Type": "application/octet-stream"},
            )
            result["status"] = response.status_code
            result["body"] = response.text
    except Exception as error:  # pragma: no cover - se propaga al assert del test
        result["error"] = repr(error)


def _put_file(base_url: str, token: str, filename: str, path, result: dict) -> None:
    try:
        with httpx.Client(base_url=base_url, timeout=120) as client:
            with open(path, "rb") as handle:
                response = client.put(
                    f"/{token}/{filename}",
                    content=handle,
                    headers={"Content-Type": "application/octet-stream"},
                )
            result["status"] = response.status_code
            result["body"] = response.text
    except Exception as error:  # pragma: no cover
        result["error"] = repr(error)


def _put_slow(base_url: str, token: str, filename: str, chunks: int, delay: float, result: dict) -> None:
    def body():
        for _ in range(chunks):
            time.sleep(delay)
            yield b"a" * 1024

    try:
        with httpx.Client(base_url=base_url, timeout=60) as client:
            response = client.put(
                f"/{token}/{filename}",
                content=body(),
                headers={"Content-Type": "application/octet-stream"},
            )
            result["status"] = response.status_code
            result["body"] = response.text
    except Exception as error:  # pragma: no cover
        result["error"] = repr(error)


def test_zero_byte_file(base_url):
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        result = {}
        thread = threading.Thread(target=_put_bytes, args=(base_url, token, "empty.bin", b"", result))
        thread.start()
        wait_for_upload(client, token, "empty.bin")
        response = client.get(f"/{token}")
        thread.join(timeout=10)
        assert not thread.is_alive()
        assert result.get("status") == 200, result
        assert response.status_code == 200
        assert response.content == b""


def test_one_kilobyte_file(base_url):
    data = b"x" * 1024
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        result = {}
        thread = threading.Thread(target=_put_bytes, args=(base_url, token, "small.txt", data, result))
        thread.start()
        wait_for_upload(client, token, "small.txt")
        response = client.get(f"/{token}")
        thread.join(timeout=10)
        assert not thread.is_alive()
        assert result.get("status") == 200, result
        assert response.status_code == 200
        assert response.content == data
        assert response.headers["content-disposition"].startswith("attachment; filename=")


def test_large_file_checksum(base_url, tmp_path):
    chunk = b"\0" * (1024 * 1024)
    path = tmp_path / "large.bin"
    with path.open("wb") as handle:
        for _ in range(64):
            handle.write(chunk)
    expected = hashlib.sha256(chunk * 64).hexdigest()

    with httpx.Client(base_url=base_url, timeout=120) as client:
        token = create_token(client)
        result = {}
        thread = threading.Thread(target=_put_file, args=(base_url, token, "large.bin", path, result))
        thread.start()
        wait_for_upload(client, token, "large.bin")
        response = client.get(f"/{token}")
        thread.join(timeout=120)
        assert not thread.is_alive()
        assert result.get("status") == 200, result
        assert response.status_code == 200
        assert hashlib.sha256(response.content).hexdigest() == expected


def test_second_uploader_is_rejected(base_url):
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        result = {}
        thread = threading.Thread(target=_put_slow, args=(base_url, token, "up.txt", 20, 0.1, result))
        thread.start()
        wait_for_upload(client, token, "up.txt")

        second = client.put(f"/{token}/other.txt", content=b"x" * 16)
        assert second.status_code == 409

        response = client.get(f"/{token}")
        thread.join(timeout=15)
        assert not thread.is_alive()
        assert result.get("status") == 200, result
        assert response.status_code == 200
        assert len(response.content) == 20 * 1024


def test_second_receiver_is_rejected(base_url):
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        result = {}
        thread = threading.Thread(target=_put_slow, args=(base_url, token, "down.txt", 20, 0.1, result))
        thread.start()
        wait_for_upload(client, token, "down.txt")

        get_result = {}

        def first_receiver():
            try:
                with httpx.Client(base_url=base_url, timeout=30) as receiver:
                    response = receiver.get(f"/{token}")
                    get_result["status"] = response.status_code
                    get_result["length"] = len(response.content)
            except Exception as error:  # pragma: no cover
                get_result["error"] = repr(error)

        receiver_thread = threading.Thread(target=first_receiver)
        receiver_thread.start()
        time.sleep(0.3)

        second = client.get(f"/{token}")
        assert second.status_code == 409

        receiver_thread.join(timeout=15)
        thread.join(timeout=15)
        assert not receiver_thread.is_alive()
        assert not thread.is_alive()
        assert get_result.get("status") == 200, get_result
        assert get_result.get("length") == 20 * 1024
        assert result.get("status") == 200, result


def test_idle_token_expires(base_url):
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        time.sleep(4)
        # /status/ fuerza la limpieza además de la tarea periódica
        client.get("/status/")
        assert client.get(f"/{token}/info").status_code == 404


def test_active_transfer_does_not_expire(base_url):
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        result = {}
        thread = threading.Thread(target=_put_slow, args=(base_url, token, "long.bin", 20, 0.5, result))
        thread.start()
        wait_for_upload(client, token, "long.bin")

        get_result = {}

        def receiver():
            try:
                with httpx.Client(base_url=base_url, timeout=60) as receiver_client:
                    response = receiver_client.get(f"/{token}")
                    get_result["status"] = response.status_code
                    get_result["length"] = len(response.content)
            except Exception as error:  # pragma: no cover
                get_result["error"] = repr(error)

        receiver_thread = threading.Thread(target=receiver)
        receiver_thread.start()
        time.sleep(4)  # supera TIMEOUT_SECONDS=3 con la transferencia en curso
        client.get("/status/")
        assert client.get(f"/{token}/info").status_code == 200

        receiver_thread.join(timeout=30)
        thread.join(timeout=30)
        assert not receiver_thread.is_alive()
        assert not thread.is_alive()
        assert result.get("status") == 200, result
        assert get_result.get("status") == 200, get_result
        assert get_result.get("length") == 20 * 1024



def test_http_download_notifies_both_websocket_peers(base_url):
    port = urlparse(base_url).port
    ws_base = f"ws://127.0.0.1:{port}"
    with httpx.Client(base_url=base_url, timeout=30) as client:
        token = create_token(client)
        put_result = {}
        put_thread = threading.Thread(
            target=_put_bytes,
            args=(base_url, token, "notify.txt", b"x" * 1024, put_result),
        )
        put_thread.start()
        wait_for_upload(client, token, "notify.txt")

        def recv_until(ws, expected, timeout=5):
            while True:
                message = json.loads(ws.recv(timeout=timeout))
                if message["type"] == expected:
                    return message

        with connect(f"{ws_base}/{token}/signal") as up, connect(f"{ws_base}/{token}/signal") as down:
            recv_until(up, "peer_connected")
            recv_until(down, "peer_connected")

            get_result = {}

            def receiver():
                with httpx.Client(base_url=base_url, timeout=30) as receiver_client:
                    response = receiver_client.get(f"/{token}")
                    get_result["status"] = response.status_code
                    get_result["length"] = len(response.content)

            get_thread = threading.Thread(target=receiver)
            get_thread.start()

            recv_until(up, "curl_download_connected")
            recv_until(down, "curl_download_connected")

            get_thread.join(timeout=15)
            put_thread.join(timeout=15)
            assert not get_thread.is_alive()
            assert not put_thread.is_alive()
            assert put_result.get("status") == 200, put_result
            assert get_result.get("status") == 200, get_result
            assert get_result.get("length") == 1024
