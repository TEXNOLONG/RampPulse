"""
Нативный голосовой движок (Walkie-Talkie / Voice Call) через VPS WebSocket.
Работает напрямую через Qt6 Multimedia (микрофон и динамики).
Без WebRTC/браузерных движков, надёжная передача аудио через VPS.
"""
import threading
import time
from typing import Optional
from PySide6.QtCore import QByteArray, QIODevice, QObject, Signal
from PySide6.QtMultimedia import (
    QAudioFormat,
    QAudioSink,
    QAudioSource,
    QMediaDevices,
)
import websocket


class VoiceEngine(QObject):
    call_connected = Signal(str)  # call_id
    call_ended = Signal()
    audio_level = Signal(float)  # 0.0 - 1.0 (для индикатора микрофона)

    def __init__(self, base_url: str):
        super().__init__()
        self.base_url = base_url.rstrip("/")
        self.call_id: Optional[str] = None
        self.token: Optional[str] = None
        self.is_in_call = False
        self.is_muted = False
        self.audio_ws: Optional[websocket.WebSocketApp] = None
        self.ws_thread: Optional[threading.Thread] = None

        # Формат звука: 16 kHz, 16 bit, Mono (высокая разборчивость речи и минимальный трафик)
        self.audio_format = QAudioFormat()
        self.audio_format.setSampleRate(16000)
        self.audio_format.setChannelCount(1)
        self.audio_format.setSampleFormat(QAudioFormat.SampleFormat.Int16)

        self.audio_source: Optional[QAudioSource] = None
        self.audio_sink: Optional[QAudioSink] = None
        self.mic_io: Optional[QIODevice] = None
        self.speaker_io: Optional[QIODevice] = None

    def set_base_url(self, url: str):
        self.base_url = url.rstrip("/")

    def start_call(self, call_id: str, token: str):
        if self.is_in_call:
            self.end_call()

        self.call_id = call_id
        self.token = token
        self.is_in_call = True

        # Инициализация динамиков
        default_output = QMediaDevices.defaultAudioOutput()
        self.audio_sink = QAudioSink(default_output, self.audio_format, self)
        self.audio_sink.setVolume(1.0)
        self.speaker_io = self.audio_sink.start()

        # Инициализация микрофона
        default_input = QMediaDevices.defaultAudioInput()
        self.audio_source = QAudioSource(default_input, self.audio_format, self)
        self.mic_io = self.audio_source.start()
        if self.mic_io:
            self.mic_io.readyRead.connect(self._on_mic_ready_read)

        # Подключение к WebSocket аудио-комнаты на VPS
        ws_proto = "wss" if self.base_url.startswith("https") else "ws"
        host = self.base_url.split("://")[-1]
        ws_url = f"{ws_proto}://{host}/ws/voice/{call_id}?token={token}"

        def on_message(ws, message):
            if isinstance(message, bytes):
                # Воспроизведение звука с VPS в динамики
                if self.speaker_io and self.speaker_io.isOpen():
                    self.speaker_io.write(message)

        def on_open(ws):
            self.call_connected.emit(call_id)

        def on_close(ws, code, msg):
            self.end_call()

        self.audio_ws = websocket.WebSocketApp(
            ws_url,
            on_open=on_open,
            on_message=on_message,
            on_close=on_close,
        )

        self.ws_thread = threading.Thread(target=self.audio_ws.run_forever, daemon=True)
        self.ws_thread.start()

    def _on_mic_ready_read(self):
        if not self.mic_io or not self.audio_ws or self.is_muted:
            if self.mic_io:
                self.mic_io.readAll()  # сброс буфера если замьючен
            return

        data: QByteArray = self.mic_io.readAll()
        raw_bytes = bytes(data)
        if raw_bytes and self.audio_ws.sock and self.audio_ws.sock.connected:
            try:
                self.audio_ws.send(raw_bytes, opcode=websocket.ABNF.OPCODE_BINARY)
            except Exception:
                pass

    def toggle_mute(self) -> bool:
        self.is_muted = not self.is_muted
        return self.is_muted

    def end_call(self):
        self.is_in_call = False
        if self.audio_source:
            self.audio_source.stop()
            self.audio_source = None
            self.mic_io = None
        if self.audio_sink:
            self.audio_sink.stop()
            self.audio_sink = None
            self.speaker_io = None
        if self.audio_ws:
            try:
                self.audio_ws.close()
            except Exception:
                pass
            self.audio_ws = None
        self.call_ended.emit()
