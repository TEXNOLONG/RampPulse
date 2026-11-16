"""
Клиент для взаимодействия с VPS сервером RampPulse (REST + WebSocket).
"""
import json
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional
import requests
import websocket


class RampPulseClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8000"):
        self.base_url = base_url.rstrip("/")
        self.token: Optional[str] = None
        self.user: Optional[Dict[str, Any]] = None
        self.session = requests.Session()
        self.ws: Optional[websocket.WebSocketApp] = None
        self.ws_thread: Optional[threading.Thread] = None
        self.is_connected = False
        self.on_state_update: Optional[Callable[[Dict[str, Any]], None]] = None
        self.on_chat_message: Optional[Callable[[Dict[str, Any]], None]] = None
        self.on_call_signal: Optional[Callable[[Dict[str, Any]], None]] = None
        self.on_connection_change: Optional[Callable[[bool], None]] = None

    def set_base_url(self, url: str):
        self.base_url = url.rstrip("/")

    def login(self, email: str, password: str) -> Dict[str, Any]:
        url = f"{self.base_url}/api/auth/login"
        resp = self.session.post(url, json={"email": email, "password": password}, timeout=10)
        if not resp.ok:
            error_msg = resp.json().get("detail", "Ошибка авторизации") if resp.headers.get("content-type", "").startswith("application/json") else resp.text
            raise RuntimeError(error_msg)
        data = resp.json()
        self.user = data.get("user")
        self.token = data.get("token")
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"
        return data

    def get_state(self) -> Dict[str, Any]:
        url = f"{self.base_url}/api/state"
        resp = self.session.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def get_airport(self) -> Dict[str, Any]:
        url = f"{self.base_url}/api/airport"
        resp = self.session.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def get_contacts(self) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/api/chat/contacts"
        resp = self.session.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json().get("contacts", [])

    def get_chat_history(self, room_kind: str, peer_id: Optional[int] = None) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/api/chat/history"
        params = {"room_kind": room_kind}
        if peer_id is not None:
            params["peer_id"] = str(peer_id)
        resp = self.session.get(url, params=params, timeout=10)
        resp.raise_for_status()
        return resp.json().get("messages", [])

    def upload_media(self, file_path: str) -> Dict[str, Any]:
        url = f"{self.base_url}/api/chat/upload"
        with open(file_path, "rb") as f:
            filename = os.path.basename(file_path)
            files = {"file": (filename, f)}
            resp = self.session.post(url, files=files, timeout=30)
            resp.raise_for_status()
            return resp.json()

    def send_chat_message(
        self,
        body: str,
        room_kind: str,
        recipient_id: Optional[int] = None,
        media_url: Optional[str] = None,
        media_type: Optional[str] = None,
        media_name: Optional[str] = None,
        duration: Optional[int] = None,
    ) -> bool:
        if not self.token or not self.user:
            raise RuntimeError("Вы не авторизованы. Сначала подключитесь к серверу и выполните вход.")

        url = f"{self.base_url}/api/chat/relay"
        user_id = self.user.get('id', 0) if isinstance(self.user, dict) else 0
        relay_key = f"{user_id}-{int(time.time()*1000)}"
        msg_payload = {
            "body": body,
            "relay_key": relay_key,
        }
        if media_url:
            msg_payload["media_url"] = media_url
            msg_payload["media_type"] = media_type or "file"
            msg_payload["media_name"] = media_name or "файл"
            if duration is not None:
                msg_payload["duration"] = duration

        payload = {
            "room_kind": room_kind,
            "recipient_id": recipient_id,
            "message": msg_payload,
        }
        resp = self.session.post(url, json=payload, timeout=10)
        if not resp.ok:
            try:
                err = resp.json().get("detail", resp.text)
            except Exception:
                err = resp.text
            raise RuntimeError(f"Ошибка сервера ({resp.status_code}): {err}")
        return True

    def approve_registration(self, user_id: int) -> Dict[str, Any]:
        url = f"{self.base_url}/api/registrations/{user_id}/approve"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def reject_registration(self, user_id: int) -> Dict[str, Any]:
        url = f"{self.base_url}/api/registrations/{user_id}/reject"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def register_engineer(self, name: str, email: str, password: str, qual: str, types: List[str], base: str, username: Optional[str] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/api/auth/register"
        payload = {
            "name": name,
            "email": email,
            "password": password,
            "qual": qual,
            "types": types,
            "base": base,
        }
        if username:
            payload["username"] = username
        resp = self.session.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def update_profile(self, username: Optional[str] = None, name: Optional[str] = None, bio: Optional[str] = None, avatar_color: Optional[str] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/api/profile/update"
        payload = {}
        if username is not None:
            payload["username"] = username
        if name is not None:
            payload["name"] = name
        if bio is not None:
            payload["bio"] = bio
        if avatar_color is not None:
            payload["avatar_color"] = avatar_color
        resp = self.session.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if "user" in data:
            self.user = data["user"]
        return data

    def search_users(self, query: str) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/api/users/search"
        resp = self.session.get(url, params={"q": query}, timeout=10)
        resp.raise_for_status()
        return resp.json().get("users", [])

    def search_chat(self, query: str, room_kind: Optional[str] = None, peer_id: Optional[int] = None) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/api/chat/search"
        params = {"q": query}
        if room_kind:
            params["room_kind"] = room_kind
        if peer_id:
            params["peer_id"] = peer_id
        resp = self.session.get(url, params=params, timeout=10)
        resp.raise_for_status()
        return resp.json().get("messages", [])

    def arrive_request(self, rid: int) -> Dict[str, Any]:
        if self.user and self.user.get("role") == "engineer":
            url = f"{self.base_url}/api/engineer/requests/{rid}/arrive"
        else:
            url = f"{self.base_url}/api/requests/{rid}/arrive"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def start_request(self, rid: int) -> Dict[str, Any]:
        if self.user and self.user.get("role") == "engineer":
            url = f"{self.base_url}/api/engineer/requests/{rid}/start"
        else:
            url = f"{self.base_url}/api/requests/{rid}/start"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def resolve_request(self, rid: int) -> Dict[str, Any]:
        if self.user and self.user.get("role") == "engineer":
            url = f"{self.base_url}/api/engineer/requests/{rid}/resolve"
        else:
            url = f"{self.base_url}/api/requests/{rid}/resolve"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def cancel_request(self, rid: int) -> Dict[str, Any]:
        url = f"{self.base_url}/api/requests/{rid}/cancel"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def set_shift(self, start: bool) -> Dict[str, Any]:
        endpoint = "start" if start else "end"
        url = f"{self.base_url}/api/engineer/shift/{endpoint}"
        resp = self.session.post(url, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def send_call_signal(self, signal: Dict[str, Any], recipient_id: int) -> bool:
        url = f"{self.base_url}/api/calls/relay"
        payload = {
            "signal": signal,
            "recipient_id": recipient_id
        }
        resp = self.session.post(url, json=payload, timeout=10)
        return resp.ok

    def create_request(self, stand: str, description: str, qual: str = "auto", priority: str = "normal") -> Dict[str, Any]:
        url = f"{self.base_url}/api/requests"
        resp = self.session.post(url, json={
            "stand": stand,
            "description": description,
            "qual": qual,
            "priority": priority
        }, timeout=10)
        resp.raise_for_status()
        return resp.json()

    def start_websocket(self):
        if self.ws:
            self.stop_websocket()

        ws_proto = "wss" if self.base_url.startswith("https") else "ws"
        host = self.base_url.split("://")[-1]
        token_param = f"?token={self.token}" if self.token else ""
        ws_url = f"{ws_proto}://{host}/ws{token_param}"

        def on_message(ws, message):
            try:
                data = json.loads(message)
                msg_type = data.get("type")
                if msg_type == "chat-message":
                    if self.on_chat_message:
                        self.on_chat_message(data.get("payload", {}))
                elif msg_type == "call-signal":
                    if self.on_call_signal:
                        self.on_call_signal(data.get("payload", {}))
                else:
                    if self.on_state_update:
                        self.on_state_update(data)
            except Exception as e:
                print(f"[WS Error]: {e}")

        def on_error(ws, error):
            print(f"[WS Network Error]: {error}")

        def on_close(ws, close_status_code, close_msg):
            self.is_connected = False
            if self.on_connection_change:
                self.on_connection_change(False)

        def on_open(ws):
            self.is_connected = True
            if self.on_connection_change:
                self.on_connection_change(True)

        self.ws = websocket.WebSocketApp(
            ws_url,
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )

        def run():
            while self.token:
                try:
                    self.ws.run_forever(ping_interval=15, ping_timeout=10)
                except Exception:
                    pass
                time.sleep(3)

        self.ws_thread = threading.Thread(target=run, daemon=True)
        self.ws_thread.start()

    def stop_websocket(self):
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None
        self.is_connected = False
