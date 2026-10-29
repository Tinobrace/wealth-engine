import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from api.fixtures import DEMO_PLAN, DEMO_SCENARIOS


app = FastAPI(title="Wealth Engine API", docs_url=None, redoc_url=None)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5500",
        "http://localhost:8080",
        "http://localhost:8765",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5500",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:8765",
    ],
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)
MAX_ACCOUNT_BYTES = 1_000_000


class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)

    class Config:
        extra = "forbid"


class DebtEntry(BaseModel):
    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    balance: int = Field(ge=0, le=1_000_000_000_000)
    annual_interest_rate: float = Field(ge=0, le=100)
    monthly_payment: int = Field(ge=0, le=1_000_000_000_000)
    due_day: int = Field(ge=1, le=31)

    class Config:
        extra = "forbid"

    @field_validator("name")
    @classmethod
    def debt_name_is_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Debt name cannot be blank.")
        return value


class SavingsGoalEntry(BaseModel):
    id: str = Field(min_length=1, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")
    name: str = Field(min_length=1, max_length=80)
    target_amount: int = Field(gt=0, le=1_000_000_000_000)
    saved_amount: int = Field(ge=0, le=1_000_000_000_000)
    monthly_contribution: int = Field(ge=0, le=1_000_000_000_000)
    contribution_day: int = Field(ge=1, le=31)

    class Config:
        extra = "forbid"

    @field_validator("name")
    @classmethod
    def savings_goal_name_is_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Savings goal name cannot be blank.")
        return value


class AccountData(BaseModel):
    plan: dict[str, Any] | None = None
    scenarios: dict[str, dict[str, Any]] = Field(default_factory=dict)
    actuals: list[dict[str, Any]] = Field(default_factory=list, max_length=10000)
    debts: list[DebtEntry] = Field(default_factory=list, max_length=100)
    savings_goals: list[SavingsGoalEntry] = Field(default_factory=list, max_length=100)

    class Config:
        extra = "forbid"

    @field_validator("debts", "savings_goals")
    @classmethod
    def private_entry_ids_are_unique(cls, entries):
        ids = [entry.id for entry in entries]
        if len(ids) != len(set(ids)):
            raise ValueError("Private entry IDs must be unique.")
        return entries


class AccountDataRequest(BaseModel):
    data: AccountData

    class Config:
        extra = "forbid"


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=4096)

    class Config:
        extra = "forbid"


def _supabase_config() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
    parsed = urllib.parse.urlparse(url)
    if not anon_key or parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise HTTPException(status_code=503, detail="Account storage is not configured.")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise HTTPException(status_code=503, detail="Account storage must use HTTPS.")
    return url, anon_key


def _supabase_request(path: str, *, anon_key: str, token: str | None = None,
                      method: str = "GET", payload: Any = None,
                      prefer: str | None = None) -> Any:
    url, _ = _supabase_config()
    headers = {
        "apikey": anon_key,
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(f"{url}{path}", data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        if error.code in {400, 401, 403, 404, 409, 422}:
            raise HTTPException(status_code=error.code, detail="Supabase rejected the request.") from error
        raise HTTPException(status_code=502, detail="Supabase request failed.") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise HTTPException(status_code=502, detail="Supabase is unavailable.") from error
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=502, detail="Supabase returned an invalid response.") from error


def _bearer_token(authorization: str | None) -> str:
    match = re.fullmatch(r"Bearer\s+([^\s]+)", authorization or "", flags=re.IGNORECASE)
    if not match:
        raise HTTPException(status_code=401, detail="Sign in to access account data.")
    return match.group(1)


def _verified_user(token: str) -> dict[str, Any]:
    _, anon_key = _supabase_config()
    user = _supabase_request("/auth/v1/user", anon_key=anon_key, token=token)
    if not isinstance(user, dict):
        raise HTTPException(status_code=401, detail="The account session is invalid.")
    try:
        UUID(str(user["id"]))
    except (KeyError, ValueError, TypeError) as error:
        raise HTTPException(status_code=401, detail="The account session is invalid.") from error
    return user


@app.middleware("http")
async def normalize_vercel_function_path(request: Request, call_next) -> Response:
    path = request.scope["path"]
    if path == "/api":
        request.scope["path"] = "/"
    elif path.startswith("/api/"):
        request.scope["path"] = path[len("/api"):]
    return await call_next(request)


@app.get("/", include_in_schema=False)
def frontend():
    return FileResponse(PROJECT_ROOT / "index.html")


@app.get("/favicon.svg", include_in_schema=False)
def favicon():
    return FileResponse(PROJECT_ROOT / "favicon.svg", media_type="image/svg+xml")


@app.get("/favicon.ico", include_in_schema=False)
def favicon_compat():
    return RedirectResponse("/favicon.svg", status_code=307)


app.mount("/css", StaticFiles(directory=PROJECT_ROOT / "css"), name="css")
app.mount("/js", StaticFiles(directory=PROJECT_ROOT / "js"), name="js")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "accounts_configured": bool(
            os.environ.get("SUPABASE_URL")
            and os.environ.get("SUPABASE_ANON_KEY")
        ),
    }


@app.get("/demo/plan")
def demo_plan():
    return DEMO_PLAN


@app.get("/demo/scenarios")
def demo_scenarios():
    return DEMO_SCENARIOS


@app.get("/demo/actuals")
def demo_actuals():
    return []


@app.post("/auth/signup")
def signup(credentials: Credentials):
    _, anon_key = _supabase_config()
    return _supabase_request(
        "/auth/v1/signup",
        anon_key=anon_key,
        method="POST",
        payload=credentials.model_dump() if hasattr(credentials, "model_dump") else credentials.dict(),
    )


@app.post("/auth/login")
def login(credentials: Credentials):
    _, anon_key = _supabase_config()
    return _supabase_request(
        "/auth/v1/token?grant_type=password",
        anon_key=anon_key,
        method="POST",
        payload=credentials.model_dump() if hasattr(credentials, "model_dump") else credentials.dict(),
    )


@app.post("/auth/refresh")
def refresh_session(body: RefreshRequest):
    _, anon_key = _supabase_config()
    return _supabase_request(
        "/auth/v1/token?grant_type=refresh_token",
        anon_key=anon_key,
        method="POST",
        payload={"refresh_token": body.refresh_token},
    )


@app.post("/auth/logout")
def logout(authorization: str | None = Header(default=None)):
    token = _bearer_token(authorization)
    _verified_user(token)
    _supabase_request("/auth/v1/logout?scope=local", anon_key=_supabase_config()[1],
                      token=token, method="POST")
    return {"ok": True}


@app.get("/auth/me")
def current_user(authorization: str | None = Header(default=None)):
    return _verified_user(_bearer_token(authorization))


@app.get("/account/data")
def get_account_data(authorization: str | None = Header(default=None)):
    token = _bearer_token(authorization)
    user = _verified_user(token)
    user_id = str(UUID(user["id"]))
    _, anon_key = _supabase_config()
    query = urllib.parse.urlencode({
        "user_id": f"eq.{user_id}",
        "select": "data",
        "limit": "1",
    })
    rows = _supabase_request(
        f"/rest/v1/wealth_engine_accounts?{query}",
        anon_key=anon_key,
        token=token,
    )
    if not isinstance(rows, list) or not rows:
        return {"data": None}
    return {"data": rows[0]["data"]}


@app.put("/account/data")
def put_account_data(body: AccountDataRequest,
                     authorization: str | None = Header(default=None)):
    token = _bearer_token(authorization)
    user = _verified_user(token)
    data = body.data.model_dump()
    encoded = json.dumps(data, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_ACCOUNT_BYTES:
        raise HTTPException(status_code=413, detail="Account data exceeds the 1 MB limit.")
    user_id = str(UUID(user["id"]))
    _, anon_key = _supabase_config()
    rows = _supabase_request(
        "/rest/v1/wealth_engine_accounts?on_conflict=user_id",
        anon_key=anon_key,
        token=token,
        method="POST",
        payload=[{"user_id": user_id, "data": data}],
        prefer="resolution=merge-duplicates,return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=502, detail="Account data was not saved.")
    return {"data": rows[0]["data"]}
