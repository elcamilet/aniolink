import json
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import aniolink  # noqa: E402


def test_sanitize_filename_removes_paths_and_controls():
    assert aniolink.sanitize_filename("../../etc/passwd") == "passwd"
    assert aniolink.sanitize_filename('a"b\r\nc.txt') == "abc.txt"
    assert aniolink.sanitize_filename("..") == "file.bin"
    assert len(aniolink.sanitize_filename("a" * 300)) <= 200


def test_content_disposition_is_safe_and_utf8():
    header = aniolink.content_disposition("informe ñ.txt")
    assert header.startswith("attachment; filename=")
    assert "filename*=UTF-8''" in header
    assert "%C3%B1" in header
    assert "\n" not in header and "\r" not in header


def test_token_retries_and_does_not_overwrite(monkeypatch):
    aniolink.active_bridges.clear()
    monkeypatch.setattr(aniolink, "TOKEN_LENGTH", 4)
    monkeypatch.setattr(aniolink.secrets, "choice", lambda _chars: "a")

    aniolink.active_bridges["aaaa"] = object()
    with pytest.raises(RuntimeError):
        aniolink.generate_token()

    aniolink.active_bridges.pop("aaaa")
    assert aniolink.generate_token() == "aaaa"
    aniolink.active_bridges.clear()


def test_metadata_is_stored_regardless_of_role():
    aniolink.active_bridges.clear()
    with TestClient(aniolink.app) as client:
        response = client.get("/token")
        token = re.search(r"TOKEN: (\w+)", response.text).group(1)

        with client.websocket_connect(f"/{token}/signal") as first:
            with client.websocket_connect(f"/{token}/signal") as second:
                assert first.receive_json()["type"] == "peer_connected"
                assert second.receive_json()["type"] == "peer_connected"

                metadata = {"type": "metadata", "name": "informe ñ.txt", "size": 12}
                second.send_text(json.dumps(metadata))
                relayed = first.receive_json()
                assert relayed["type"] == "metadata"

                info = client.get(f"/{token}/info")
                assert info.status_code == 200
                assert info.json()["name"] == "informe ñ.txt"

        assert client.get(f"/{token}/info").status_code == 200

    aniolink.active_bridges.clear()
