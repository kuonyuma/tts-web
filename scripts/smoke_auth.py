"""Offline container HTTP check; feed this file to docker exec python - create/restart."""
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = "http://127.0.0.1:8000"
STATE_PATH = Path("/tmp/tts-auth-smoke.json")
cookies = http.cookiejar.CookieJar()
browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))


def request(path, body=None, headers=None, method=None, opener=browser):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Origin": BASE_URL,
               "Sec-Fetch-Site": "same-origin", **(headers or {})}
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        response = opener.open(req, timeout=5)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if raw and path.startswith("/api/") else raw, response.headers


for attempt in range(40):
    try:
        if request("/health")[0] == 200:
            break
    except (OSError, urllib.error.URLError):
        pass
    time.sleep(0.2)
else:
    raise RuntimeError("Container did not become healthy")


if sys.argv[1] == "create":
    signup = {"username": "smoke_user", "email": "smoke@example.com", "password": "example-password"}
    status, user, _ = request("/api/users/register", signup)
    assert status == 201 and user["role"] == "user"
    assert not {"password", "password_hash"}.intersection(user)
    assert request("/api/users/register", signup)[0] == 409
    assert request("/api/users/register", {**signup, "username": "x"})[0] == 422
    login = {"identity": signup["username"], "password": signup["password"]}
    status, session, headers = request("/api/auth/login", login)
    assert status == 200 and "HttpOnly" in " ".join(headers.get_all("Set-Cookie"))
    token = session["access_token"]
    assert request("/api/auth/me")[1]["id"] == user["id"]
    bare = urllib.request.build_opener()
    bearer = {"Authorization": "Bearer " + token}
    assert request("/api/auth/me", headers=bearer, opener=bare)[0] == 200
    assert request("/api/auth/logout", method="POST")[0] == 403
    csrf = next(cookie.value for cookie in cookies if cookie.name == "tts_csrf")
    assert request("/api/auth/logout", headers={"X-CSRF-Token": csrf}, method="POST")[0] == 204
    assert request("/api/auth/me", headers=bearer, opener=bare)[0] == 401
    _, session, _ = request("/api/auth/login", login)
    STATE_PATH.write_text(json.dumps({"token": session["access_token"], "id": user["id"]}))
    assert b"registerForm" in request("/account.html")[1]
    print("PASS container registration, validation, Cookie/Bearer, CSRF and logout revocation")
elif sys.argv[1] == "restart":
    state = json.loads(STATE_PATH.read_text())
    status, user, _ = request("/api/auth/me", headers={"Authorization": "Bearer " + state["token"]})
    assert status == 200 and user["id"] == state["id"]
    STATE_PATH.unlink()
    print("PASS container restart preserves users, signing key and active sessions")
else:
    raise ValueError("Expected create or restart")
