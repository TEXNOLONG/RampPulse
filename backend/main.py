"""FastAPI: REST + WebSocket. Запуск: python run.py"""
import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import (
    DEMO_DISPATCHER_PASSWORD,
    DEMO_ENGINEER_PASSWORD,
    SESSION_COOKIE,
    SESSION_TTL_SEC,
    AuthError,
    AuthStore,
)
from .chat import ChatArchive
from .db import DB
from .engine import ACTIVE, QUALS, STATUS_RU, TYPE_FAMILIES, Engine

ROOT = Path(__file__).resolve().parent.parent
AIRPORT_FILE = Path(os.environ.get("AIRPORT_FILE", ROOT / "data" / "airport_demo.json"))
TECHS_FILE = Path(os.environ.get("TECHS_FILE", ROOT / "data" / "technicians.json"))
DB_FILE = os.environ.get("DB_FILE", str(ROOT / "dispatch.db"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").lower() in ("1", "true", "yes")
DEMO_MODE = os.environ.get("DEMO_MODE", "1").lower() not in ("0", "false", "no", "off")
UPLOAD_DIR = ROOT / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

airport = json.loads(AIRPORT_FILE.read_text(encoding="utf-8"))
techs_cfg = json.loads(TECHS_FILE.read_text(encoding="utf-8"))
store = DB(DB_FILE)
auth = AuthStore(DB_FILE, tech_seed_count=len(techs_cfg))
chat_archive = ChatArchive(DB_FILE)
if DEMO_MODE:
    auth.seed_demo(techs_cfg)
else:
    admin_email = os.environ.get("DISPATCHER_EMAIL", "").strip()
    admin_password = os.environ.get("DISPATCHER_PASSWORD", "")
    if admin_email and admin_password:
        try:
            auth.ensure_dispatcher(
                admin_email,
                admin_password,
                os.environ.get("DISPATCHER_NAME", "Диспетчер смены"),
            )
        except AuthError as e:
            print(f"[auth] не удалось создать диспетчера: {e}")
    elif not auth.has_dispatcher():
        print("[auth] DEMO_MODE=0, но DISPATCHER_EMAIL/DISPATCHER_PASSWORD не заданы — войти некому")
engine = Engine(airport, techs_cfg, store)
for account in auth.list_active_engineers():
    try:
        engine.add_engineer_tech(account)
        engine.set_tech_on_shift(account["tech_id"], account.get("on_shift", True))
    except ValueError:
        pass
engine.dirty = True

clients: dict[WebSocket, dict] = {}


# ---------- авторизация ----------
def _cookie_user(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        auth_hdr = request.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            token = auth_hdr[7:].strip()
        elif not token:
            token = request.query_params.get("token")
    return auth.user_for_token(token)


def current_user(request: Request) -> dict:
    user = _cookie_user(request)
    if not user:
        raise HTTPException(401, "Требуется вход в систему")
    return user


def dispatcher_only(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "dispatcher":
        raise HTTPException(403, "Действие доступно только диспетчеру")
    return user


def engineer_only(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "engineer":
        raise HTTPException(403, "Действие доступно только инженеру")
    return user


def _login_status(error: AuthError) -> int:
    if error.code == "invalid_credentials":
        return 401
    if error.code in ("pending", "blocked"):
        return 403
    return 400


def dispatcher_payload(user: dict) -> dict:
    data = engine.snapshot()
    data["me"] = user
    data["registrations"] = auth.list_pending_engineers()
    data["airport_name"] = airport.get("name")
    return data


def engineer_payload(user: dict) -> dict:
    data = engine.engineer_snapshot(user.get("tech_id"))
    data["account"] = user
    data["airport_name"] = airport.get("name")
    return data


def state_for(user: dict) -> dict:
    return dispatcher_payload(user) if user["role"] == "dispatcher" else engineer_payload(user)


async def broadcast():
    if not clients:
        return
    cache: dict[tuple, str] = {}
    for ws, user in list(clients.items()):
        key = ("dispatcher",) if user["role"] == "dispatcher" else ("engineer", user.get("tech_id"))
        if key not in cache:
            try:
                cache[key] = json.dumps(state_for(user), ensure_ascii=False)
            except Exception:
                clients.pop(ws, None)
                continue
        try:
            await ws.send_text(cache[key])
        except Exception:
            clients.pop(ws, None)


async def sim_loop():
    last = time.monotonic()
    since_push = 0.0
    while True:
        await asyncio.sleep(0.2)
        now = time.monotonic()
        dt, last = now - last, now
        engine.tick(dt)
        since_push += dt
        if since_push >= 0.4:
            since_push = 0.0
            await broadcast()


@asynccontextmanager
async def lifespan(_):
    task = asyncio.create_task(sim_loop())
    yield
    task.cancel()


app = FastAPI(title="Умная диспетчеризация RampPulse", lifespan=lifespan)


async def act(fn, *args, **kw):
    try:
        result = fn(*args, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast()
    return result


# ---------- модели ----------
class LoginBody(BaseModel):
    email: str
    password: str


class RegisterBody(BaseModel):
    name: str
    email: str
    password: str
    qual: str
    types: list[str] = []
    base: str
    username: str | None = None


class ProfileUpdateBody(BaseModel):
    username: str | None = None
    name: str | None = None
    bio: str | None = None
    avatar_color: str | None = None


class NewRequest(BaseModel):
    stand: str
    description: str
    qual: str = "auto"
    extra: str = ""
    priority: str = "normal"


class BlockBody(BaseModel):
    blocked: bool


class SpeedBody(BaseModel):
    speed: int | None = None
    running: bool | None = None


class TechnicianPositionBody(BaseModel):
    x: float
    y: float


class TechnicianProfileBody(BaseModel):
    qual: str
    types: list[str]


class ChatRelayBody(BaseModel):
    message: dict
    room_kind: str
    recipient_id: int | None = None


class CallRelayBody(BaseModel):
    signal: dict
    recipient_id: int


class ChatReadRelayBody(BaseModel):
    relay_key: str
    sender_id: int


# ---------- публичные страницы и метаданные ----------
@app.get("/api/meta")
def get_meta():
    return {
        "airport": {"name": airport.get("name"), "source": airport.get("source")},
        "quals": list(QUALS),
        "types": list(TYPE_FAMILIES),
        "bases": [{"id": b["id"], "name": b["name"]} for b in airport.get("bases", [])],
        "demo": {
            "enabled": DEMO_MODE,
            "dispatcher_email": "dispatcher@oto.ru",
            "dispatcher_password": DEMO_DISPATCHER_PASSWORD,
            "engineer_email": "tech1@oto.ru",
            "engineer_password": DEMO_ENGINEER_PASSWORD,
        } if DEMO_MODE else {"enabled": False},
    }


@app.get("/api/auth/me")
def get_me(user: dict = Depends(current_user)):
    return {"user": user}


@app.post("/api/auth/login")
def login(body: LoginBody, response: Response):
    try:
        user = auth.authenticate(body.email, body.password)
    except AuthError as e:
        raise HTTPException(_login_status(e), str(e))
    token = auth.create_session(user["id"])
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL_SEC,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )
    return {
        "user": user,
        "token": token,
        "redirect": "/" if user["role"] == "dispatcher" else "/engineer",
    }


@app.post("/api/auth/register")
def register(body: RegisterBody):
    if body.qual not in QUALS:
        raise HTTPException(400, "Неизвестная квалификация")
    if body.base not in engine.bases:
        raise HTTPException(400, "Неизвестная база")
    invalid_types = sorted(set(body.types) - set(TYPE_FAMILIES))
    if invalid_types:
        raise HTTPException(400, "Неизвестный тип ВС: " + ", ".join(invalid_types))
    try:
        user = auth.register_engineer(
            body.name, body.email, body.password, body.qual, body.types, body.base, body.username
        )
    except AuthError as e:
        raise HTTPException(400, str(e))
    return {
        "status": "pending",
        "user": user,
        "message": "Заявка отправлена. Диспетчер подтвердит допуск к смене.",
    }


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    auth.delete_session(request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ---------- данные ----------
@app.get("/api/airport")
def get_airport(user: dict = Depends(current_user)):
    edges = [{**e, "length": round(e["length"], 1)} for e in engine.graph.edges.values()]
    return {**airport, "edges": edges}


@app.get("/api/state")
def get_state(user: dict = Depends(current_user)):
    return state_for(user)


@app.get("/api/chat/contacts")
def chat_contacts(user: dict = Depends(current_user)):
    all_users = auth.list_active_dispatchers() + auth.list_active_engineers()
    contacts = [u for u in all_users if u["id"] != user["id"]]
    return {"contacts": [
        {
            "id": item["id"],
            "username": item.get("username") or f"user{item['id']}",
            "name": item["name"],
            "role": item["role"],
            "qual": item.get("qual"),
            "on_shift": item.get("on_shift", True),
        } for item in contacts
    ]}


@app.get("/api/chat/history")
def chat_history(room_kind: str, peer_id: int | None = None, user: dict = Depends(current_user)):
    if room_kind == "shift":
        peer_id = None
    elif room_kind == "direct":
        if peer_id is None:
            raise HTTPException(400, "Не указан собеседник")
        _chat_peer(user, peer_id)
    else:
        raise HTTPException(400, "Неизвестный тип чата")
    return {"messages": chat_archive.history(room_kind=room_kind, user_id=user["id"], peer_id=peer_id)}


def _chat_peer(user: dict, recipient_id: int) -> dict:
    peer = auth.get_user(recipient_id)
    if not peer or peer["status"] != "active":
        raise HTTPException(404, "Собеседник недоступен")
    if peer["id"] == user["id"]:
        raise HTTPException(400, "Нельзя писать самому себе")
    return peer


async def _send_to_user(recipient_id: int, event: dict):
    for socket, connected in list(clients.items()):
        if connected.get("id") == recipient_id:
            try:
                await socket.send_text(json.dumps(event, ensure_ascii=False))
            except Exception:
                clients.pop(socket, None)


@app.post("/api/chat/relay")
async def relay_chat(body: ChatRelayBody, user: dict = Depends(current_user)):
    if body.room_kind == "direct":
        if body.recipient_id is None:
            raise HTTPException(400, "Не указан собеседник")
        _chat_peer(user, body.recipient_id)
        recipient_ids = [body.recipient_id]
    elif body.room_kind == "shift":
        recipient_ids = [peer["id"] for peer in auth.list_active_dispatchers() + auth.list_active_engineers() if peer["id"] != user["id"]]
    else:
        raise HTTPException(400, "Неизвестный тип чата")
    sender_uname = user.get("username") or f"user{user['id']}"
    message = {
        **body.message,
        "from_user_id": user["id"],
        "sender_name": user["name"],
        "sender_username": sender_uname,
    }
    raw_text = message.get("body") or ""
    sticker = message.get("sticker")
    media_url = message.get("media_url")
    media_type = message.get("media_type")
    media_name = message.get("media_name")
    duration = message.get("duration")
    if not isinstance(raw_text, str) or (sticker is not None and not isinstance(sticker, str)):
        raise HTTPException(400, "Некорректное сообщение")
    text = raw_text.strip()
    relay_key = str(message.get("relay_key") or "")
    if len(text) > 2000:
        raise HTTPException(400, "Сообщение не должно превышать 2000 символов")
    if len(sticker or "") > 48:
        raise HTTPException(400, "Недопустимый стикер")
    if not relay_key or (not text and not sticker and not media_url):
        raise HTTPException(400, "Введите сообщение, выберите стикер или прикрепите файл")
    archived = chat_archive.save(
        relay_key=relay_key,
        room_kind=body.room_kind,
        sender_id=user["id"],
        sender_name=user["name"],
        recipient_id=body.recipient_id if body.room_kind == "direct" else None,
        body=text,
        sticker=str(sticker) if sticker else None,
        media_url=str(media_url) if media_url else None,
        media_type=str(media_type) if media_type else None,
        media_name=str(media_name) if media_name else None,
        duration=int(duration) if duration is not None else None,
        sender_username=sender_uname,
    )
    message.update(archived)
    message["room_kind"] = body.room_kind
    event = {"type": "chat-message", "payload": message, "room_kind": body.room_kind}
    for recipient_id in recipient_ids:
        await _send_to_user(recipient_id, event)
    return {"ok": True}


@app.post("/api/profile/update")
def update_profile(body: ProfileUpdateBody, user: dict = Depends(current_user)):
    try:
        updated = auth.update_profile(
            user["id"],
            username=body.username,
            name=body.name,
            bio=body.bio,
            avatar_color=body.avatar_color,
        )
        return {"ok": True, "user": updated}
    except AuthError as e:
        raise HTTPException(400, str(e))


@app.get("/api/users/search")
def search_users(q: str = "", user: dict = Depends(current_user)):
    return {"users": auth.search_users(q)}


@app.get("/api/chat/search")
def search_chat_messages(q: str = "", room_kind: str | None = None, peer_id: int | None = None, user: dict = Depends(current_user)):
    return {"messages": chat_archive.search(q, user_id=user["id"], room_kind=room_kind, peer_id=peer_id)}


@app.post("/api/chat/upload")
async def upload_chat_media(file: UploadFile = File(...), user: dict = Depends(current_user)):
    ext = Path(file.filename or "file").suffix.lower()
    safe_name = f"{int(time.time()*1000)}_{uuid.uuid4().hex[:8]}{ext}"
    dest_path = UPLOAD_DIR / safe_name
    content = await file.read()
    dest_path.write_bytes(content)

    media_type = "file"
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}:
        media_type = "image"
    elif ext in {".wav", ".mp3", ".ogg", ".webm", ".m4a", ".aac"}:
        media_type = "audio_voice"

    return {
        "url": f"/uploads/{safe_name}",
        "media_type": media_type,
        "media_name": file.filename or safe_name,
        "size": len(content),
    }


@app.post("/api/chat/relay-read")
async def relay_chat_read(body: ChatReadRelayBody, user: dict = Depends(current_user)):
    sender = auth.get_user(body.sender_id)
    if not sender or sender["status"] != "active" or sender["id"] == user["id"]:
        raise HTTPException(404, "Собеседник недоступен")
    chat_archive.mark_read(body.relay_key, user["id"], sender["id"])
    event = {"type":"chat-read", "payload":{"relay_key":body.relay_key,"reader_name":user["name"]}}
    await _send_to_user(sender["id"], event)
    return {"ok":True}


@app.post("/api/calls/relay")
async def relay_call(body: CallRelayBody, user: dict = Depends(current_user)):
    peer = _chat_peer(user, body.recipient_id)
    kind = body.signal.get("kind")
    if kind not in {"ring", "offer", "answer", "ice", "hangup", "decline", "busy"}:
        raise HTTPException(400, "Неизвестное событие звонка")
    event = {"type": "call-signal", "payload": {**body.signal, "from_user_id": user["id"], "from_name": user["name"], "from_role": user["role"]}}
    await _send_to_user(peer["id"], event)
    return {"ok": True}


# ---------- действия диспетчера ----------
@app.post("/api/requests", dependencies=[Depends(dispatcher_only)])
async def create_request(body: NewRequest):
    req = await act(engine.create_request, body.stand, body.description, body.qual, body.extra, body.priority)
    return {"id": req["id"], "status": req["status"]}


@app.post("/api/requests/{rid}/arrive", dependencies=[Depends(dispatcher_only)])
async def arrive(rid: int):
    await act(engine.mark_arrived, rid)
    return {"ok": True}


@app.post("/api/requests/{rid}/start", dependencies=[Depends(dispatcher_only)])
async def start(rid: int):
    await act(engine.start_work, rid)
    return {"ok": True}


@app.post("/api/requests/{rid}/resolve", dependencies=[Depends(dispatcher_only)])
async def resolve(rid: int):
    await act(engine.resolve, rid)
    return {"ok": True}


@app.post("/api/requests/{rid}/cancel", dependencies=[Depends(dispatcher_only)])
async def cancel(rid: int):
    await act(engine.cancel, rid)
    return {"ok": True}


@app.post("/api/edges/{edge_id}/block", dependencies=[Depends(dispatcher_only)])
async def block_edge(edge_id: str, body: BlockBody):
    await act(engine.set_edge_blocked, edge_id, body.blocked)
    return {"ok": True}


@app.post("/api/sim", dependencies=[Depends(dispatcher_only)])
async def set_sim(body: SpeedBody):
    if body.speed is not None:
        await act(engine.set_speed, body.speed)
    if body.running is not None:
        await act(engine.set_running, body.running)
    return {"ok": True}


@app.post("/api/techs/{tech_id}/position", dependencies=[Depends(dispatcher_only)])
async def move_technician(tech_id: int, body: TechnicianPositionBody):
    tech = await act(engine.move_tech, tech_id, body.x, body.y)
    return {"id": tech.id, "x": tech.x, "y": tech.y, "node": tech.node}


@app.post("/api/techs/{tech_id}/profile", dependencies=[Depends(dispatcher_only)])
async def update_technician_profile(tech_id: int, body: TechnicianProfileBody):
    tech = await act(engine.update_tech_profile, tech_id, body.qual, body.types)
    return {"id": tech.id, "qual": tech.qual, "types": list(tech.types)}


@app.post("/api/reset", dependencies=[Depends(dispatcher_only)])
async def reset():
    await act(engine.reset)
    return {"ok": True}


@app.post("/api/aircraft/spawn", dependencies=[Depends(dispatcher_only)])
async def spawn_aircraft():
    ac = await act(engine.spawn_aircraft_manual)
    return {"id": ac.id if ac else None, "flight": ac.flight if ac else None}


@app.post("/api/aircraft/{aid}/depart", dependencies=[Depends(dispatcher_only)])
async def depart_aircraft(aid: int):
    await act(engine.force_depart, aid)
    return {"ok": True}


# ---------- действия инженера ----------
def _engineer_request(rid: int, user: dict) -> dict:
    req = engine.requests.get(rid)
    if not req or req.get("tech_id") != user.get("tech_id"):
        raise HTTPException(404, "Заявка не назначена вам")
    return req


@app.post("/api/engineer/requests/{rid}/arrive")
async def engineer_arrive(rid: int, user: dict = Depends(engineer_only)):
    _engineer_request(rid, user)
    await act(engine.mark_arrived, rid, "инженером")
    return {"ok": True}


@app.post("/api/engineer/requests/{rid}/start")
async def engineer_start(rid: int, user: dict = Depends(engineer_only)):
    _engineer_request(rid, user)
    await act(engine.start_work, rid)
    return {"ok": True}


@app.post("/api/engineer/requests/{rid}/resolve")
async def engineer_resolve(rid: int, user: dict = Depends(engineer_only)):
    _engineer_request(rid, user)
    await act(engine.resolve, rid)
    return {"ok": True}


@app.post("/api/engineer/shift/start")
async def engineer_shift_start(user: dict = Depends(engineer_only)):
    try:
        account = auth.set_engineer_shift(user["id"], True)
        engine.set_tech_on_shift(account["tech_id"], True)
    except (AuthError, ValueError) as e:
        raise HTTPException(400, str(e))
    user.update(account)
    for connected in clients.values():
        if connected.get("id") == user["id"]:
            connected.update(account)
    engine.log(f"{account['name']} вышел на смену", None, "info")
    await broadcast()
    return {"ok": True, "account": account}


@app.post("/api/engineer/shift/end")
async def engineer_shift_end(user: dict = Depends(engineer_only)):
    tid = user.get("tech_id")
    active = next((r for r in engine.requests.values()
                   if r.get("tech_id") == tid and r.get("status") in ACTIVE), None)
    if active:
        status = STATUS_RU.get(active["status"], active["status"])
        raise HTTPException(409, f"Нельзя завершить смену: заявка #{active['id']} ещё не выполнена ({status}). Сначала завершите заявку.")
    try:
        engine.set_tech_on_shift(tid, False)
        account = auth.set_engineer_shift(user["id"], False)
    except (AuthError, ValueError) as e:
        raise HTTPException(400, str(e))
    user.update(account)
    for connected in clients.values():
        if connected.get("id") == user["id"]:
            connected.update(account)
    engine.log(f"{account['name']} завершил смену", None, "info")
    await broadcast()
    return {"ok": True, "account": account}


# ---------- заявки на регистрацию ----------
@app.post("/api/registrations/{user_id}/approve")
async def approve_registration(user_id: int, _: dict = Depends(dispatcher_only)):
    try:
        user = auth.approve_engineer(user_id)
        engine.add_engineer_tech(user)
    except (AuthError, ValueError) as e:
        raise HTTPException(400, str(e))
    engine.log(f"Допуск подтверждён: {user['name']} ({user['qual']}, {user['base']})", None, "info")
    await broadcast()
    return {"ok": True, "user": user}


@app.post("/api/registrations/{user_id}/reject")
async def reject_registration(user_id: int, _: dict = Depends(dispatcher_only)):
    try:
        user = auth.reject_engineer(user_id)
    except AuthError as e:
        raise HTTPException(400, str(e))
    engine.log(f"Заявка на регистрацию отклонена: {user['name']}", None, "warn")
    await broadcast()
    return {"ok": True, "user": user}


# ---------- WebSocket ----------
voice_rooms: dict[str, set[WebSocket]] = {}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    token = ws.cookies.get(SESSION_COOKIE) or ws.query_params.get("token")
    if not token:
        auth_hdr = ws.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            token = auth_hdr[7:].strip()
    user = auth.user_for_token(token)
    if not user:
        await ws.close(code=4401)
        return
    clients[ws] = user
    try:
        await ws.send_text(json.dumps(state_for(user), ensure_ascii=False))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.pop(ws, None)


@app.websocket("/ws/voice/{call_id}")
async def ws_voice(ws: WebSocket, call_id: str):
    await ws.accept()
    token = ws.cookies.get(SESSION_COOKIE) or ws.query_params.get("token")
    if not token:
        auth_hdr = ws.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            token = auth_hdr[7:].strip()
    user = auth.user_for_token(token)
    if not user:
        await ws.close(code=4401)
        return
    room = voice_rooms.setdefault(call_id, set())
    room.add(ws)
    try:
        while True:
            message = await ws.receive()
            if "bytes" in message and message["bytes"]:
                chunk = message["bytes"]
                for peer in list(room):
                    if peer != ws:
                        try:
                            await peer.send_bytes(chunk)
                        except Exception:
                            room.discard(peer)
            elif "text" in message and message["text"]:
                text_data = message["text"]
                for peer in list(room):
                    if peer != ws:
                        try:
                            await peer.send_text(text_data)
                        except Exception:
                            room.discard(peer)
    except WebSocketDisconnect:
        pass
    finally:
        room.discard(ws)
        if not room:
            voice_rooms.pop(call_id, None)


# ---------- страницы ----------
@app.get("/")
def index(request: Request):
    user = _cookie_user(request)
    if not user:
        return RedirectResponse("/login?next=/", status_code=303)
    if user["role"] != "dispatcher":
        return RedirectResponse("/engineer", status_code=303)
    return FileResponse(ROOT / "frontend" / "index.html")


@app.get("/engineer")
def engineer_page(request: Request):
    user = _cookie_user(request)
    if not user:
        return RedirectResponse("/login?next=/engineer", status_code=303)
    if user["role"] != "engineer":
        return RedirectResponse("/", status_code=303)
    return FileResponse(ROOT / "frontend" / "engineer.html")


@app.get("/login")
def login_page(request: Request):
    user = _cookie_user(request)
    if user:
        return RedirectResponse("/" if user["role"] == "dispatcher" else "/engineer", status_code=303)
    return FileResponse(ROOT / "frontend" / "auth.html")


@app.get("/register")
def register_page():
    return RedirectResponse("/login?mode=register", status_code=303)


@app.get("/healthz")
def healthz():
    return {"ok": True, "airport": airport.get("name")}


app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
