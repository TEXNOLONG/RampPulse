"""
Клиент для взаимодействия с VPS сервером RampPulse (REST + WebSocket).
"""
import json
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

    def send_chat_message(self, body: str, room_kind: str, recipient_id: Optional[int] = None) -> bool:
        url = f"{self.base_url}/api/chat/relay"
        relay_key = f"{self.user.get('id', 0)}-{int(time.time()*1000)}"
        payload = {
            "room_kind": room_kind,
            "recipient_id": recipient_id,
            "message": {
                "body": body,
                "relay_key": relay_key
            }
        }
        resp = self.session.post(url, json=payload, timeout=10)
        return resp.ok

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
