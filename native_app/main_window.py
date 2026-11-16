"""
Главное окно нативного приложения RampPulse на Qt6.
Полностью автономный нативный GUI без браузерных движков.
"""
import json
import os
import time
from typing import Any, Dict, List, Optional
from PySide6.QtCore import QDateTime, QPointF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFormLayout,
    QFrame,
    QGraphicsView,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .api_client import RampPulseClient
from .map_view import AirportMapView
from .ui_theme import DARK_THEME_QSS
from .voice_engine import VoiceEngine


class MainWindow(QMainWindow):
    state_received = Signal(dict)
    chat_received = Signal(dict)
    call_signal_received = Signal(dict)

    def __init__(self, default_server: str = "http://127.0.0.1:8000"):
        super().__init__()
        self.setWindowTitle("RampPulse · Операционный центр аэропорта")
        self.resize(1440, 900)
        self.setMinimumSize(1024, 680)

        self.client = RampPulseClient(default_server)
        self.voice = VoiceEngine(default_server)

        self.current_user: Optional[Dict[str, Any]] = None
        self.active_room_kind = "shift"
        self.active_peer_id: Optional[int] = None
        self.active_peer_name: str = "Общий канал смены"
        self.active_call_id: Optional[str] = None
        self.call_start_time: float = 0.0

        self.init_ui()
        self.setup_signals()

        # Таймер часов UTC
        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self.update_clock)
        self.clock_timer.start(1000)

        # Таймер длительности звонка
        self.call_timer = QTimer(self)
        self.call_timer.timeout.connect(self.update_call_timer)

    def init_ui(self):
        central_widget = QWidget(self)
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(12, 10, 12, 10)
        main_layout.setSpacing(10)

        # ---------- ХЕДЕР (Верхняя панель) ----------
        header = QFrame(self)
        header.setStyleSheet("background-color: #0B1120; border: 1px solid #1E293B; border-radius: 8px; padding: 6px 12px;")
        h_layout = QHBoxLayout(header)
        h_layout.setContentsMargins(8, 4, 8, 4)

        # Логотип и заголовок
        title_box = QVBoxLayout()
        title_label = QLabel("RAMPPULSE · DISPATCH", self)
        title_label.setStyleSheet("font-size: 16px; font-weight: 800; color: #38BDF8; letter-spacing: 1px;")
        sub_title = QLabel("Операционный центр диспетчеризации", self)
        sub_title.setStyleSheet("font-size: 11px; color: #94A3B8;")
        title_box.addWidget(title_label)
        title_box.addWidget(sub_title)
        h_layout.addLayout(title_box)

        h_layout.addSpacing(24)

        # Выбор аэропорта
        h_layout.addWidget(QLabel("Аэропорт:", self))
        self.airport_combo = QComboBox(self)
        self.airport_combo.addItems(["Шереметьево (SVO · UUEE)", "Домодедово (DME · UUDD)"])
        self.airport_combo.currentIndexChanged.connect(self.on_airport_changed)
        h_layout.addWidget(self.airport_combo)

        h_layout.addSpacing(16)

        # Статус подключения к VPS
        self.vps_indicator = QLabel("● VPS: Офлайн", self)
        self.vps_indicator.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 12px;")
        h_layout.addWidget(self.vps_indicator)

        # Кнопка настройки сервера / входа
        self.settings_btn = QPushButton("Настройки VPS", self)
        self.settings_btn.clicked.connect(self.open_settings_dialog)
        h_layout.addWidget(self.settings_btn)

        h_layout.addStretch()

        # Пользователь
        self.user_label = QLabel("Не авторизован", self)
        self.user_label.setStyleSheet("color: #F8FAFC; font-weight: 600; font-size: 12px;")
        h_layout.addWidget(self.user_label)

        # Часы
        self.clock_label = QLabel("00:00:00 UTC", self)
        self.clock_label.setStyleSheet("color: #38BDF8; font-family: monospace; font-size: 13px; font-weight: bold;")
        h_layout.addWidget(self.clock_label)

        main_layout.addWidget(header)

        # ---------- ВКЛАДКИ ПРИЛОЖЕНИЯ ----------
        self.tabs = QTabWidget(self)

        # Вкладка 1: Карта перрона
        self.tab_map = QWidget()
        self.init_map_tab()
        self.tabs.addTab(self.tab_map, "Оперативная карта (2D Radar)")

        # Вкладка 2: Рейсы и воздушные суда
        self.tab_flights = QWidget()
        self.init_flights_tab()
        self.tabs.addTab(self.tab_flights, "Борты и рейсы")

        # Вкладка 3: Инженеры и техники смены
        self.tab_techs = QWidget()
        self.init_techs_tab()
        self.tabs.addTab(self.tab_techs, "Инженеры смены")

        # Вкладка 4: Заявки на обслуживание
        self.tab_requests = QWidget()
        self.init_requests_tab()
        self.tabs.addTab(self.tab_requests, "Заявки на обслуживание")

        # Вкладка 5: Чат и голосовая связь (Walkie-Talkie)
        self.tab_chat = QWidget()
        self.init_chat_tab()
        self.tabs.addTab(self.tab_chat, "Связь и Чат (Рация)")

        main_layout.addWidget(self.tabs)

        # Строка состояния (Status Bar)
        self.statusBar().showMessage("Готов к работе. Подключитесь к VPS серверу.")
        self.statusBar().setStyleSheet("background-color: #070B12; color: #64748B; font-size: 11px;")

    def setup_signals(self):
        self.state_received.connect(self.on_state_received)
        self.chat_received.connect(self.on_chat_message_received)
        self.call_signal_received.connect(self.on_call_signal)

        self.client.on_state_update = lambda s: self.state_received.emit(s)
        self.client.on_chat_message = lambda m: self.chat_received.emit(m)
        self.client.on_call_signal = lambda sig: self.call_signal_received.emit(sig)
        self.client.on_connection_change = self.on_connection_change

        self.voice.call_connected.connect(self.on_voice_call_connected)
        self.voice.call_ended.connect(self.on_voice_call_ended)

    # ---------- ИНИЦИАЛИЗАЦИЯ ВКЛАДОК ----------
    def init_map_tab(self):
        layout = QVBoxLayout(self.tab_map)
        layout.setContentsMargins(6, 6, 6, 6)

        # Панель инструментов карты
        toolbar = QHBoxLayout()
        btn_fit = QPushButton("Центрировать карту", self)
        btn_fit.clicked.connect(lambda: self.map_view.fit_airport())
        toolbar.addWidget(btn_fit)

        btn_zin = QPushButton("+ Масштаб", self)
        btn_zin.clicked.connect(lambda: self.map_view.scale(1.2, 1.2))
        toolbar.addWidget(btn_zin)

        btn_zout = QPushButton("- Масштаб", self)
        btn_zout.clicked.connect(lambda: self.map_view.scale(0.8, 0.8))
        toolbar.addWidget(btn_zout)

        toolbar.addStretch()

        self.map_info_label = QLabel("Перетаскивание: ЛКМ · Масштаб: Колёсико мыши", self)
        self.map_info_label.setStyleSheet("color: #64748B; font-size: 11px;")
        toolbar.addWidget(self.map_info_label)

        layout.addLayout(toolbar)

        self.map_view = AirportMapView(self)
        layout.addWidget(self.map_view)

    def init_flights_tab(self):
        layout = QVBoxLayout(self.tab_flights)
        layout.setContentsMargins(10, 10, 10, 10)

        btn_layout = QHBoxLayout()
        btn_new_ac = QPushButton("+ Добавить прибывающий рейс", self)
        btn_new_ac.setProperty("class", "primary-btn")
        btn_new_ac.clicked.connect(self.spawn_aircraft)
        btn_layout.addWidget(btn_new_ac)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        self.flights_table = QTableWidget(self)
        self.flights_table.setColumnCount(6)
        self.flights_table.setHorizontalHeaderLabels(["Рейс", "Стоянка", "Тип ВС", "Статус", "Норматив 15 мин", "Действие"])
        self.flights_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.flights_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.flights_table)

    def init_techs_tab(self):
        layout = QVBoxLayout(self.tab_techs)
        layout.setContentsMargins(10, 10, 10, 10)

        self.techs_table = QTableWidget(self)
        self.techs_table.setColumnCount(6)
        self.techs_table.setHorizontalHeaderLabels(["Сотрудник", "Квалификация", "Допуски ВС", "Статус", "На смене", "Связь"])
        self.techs_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.techs_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.techs_table)

    def init_requests_tab(self):
        layout = QVBoxLayout(self.tab_requests)
        layout.setContentsMargins(10, 10, 10, 10)

        btn_layout = QHBoxLayout()
        btn_new_req = QPushButton("+ Создать заявку на обслуживание", self)
        btn_new_req.setProperty("class", "primary-btn")
        btn_new_req.clicked.connect(self.open_new_request_dialog)
        btn_layout.addWidget(btn_new_req)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        self.requests_table = QTableWidget(self)
        self.requests_table.setColumnCount(6)
        self.requests_table.setHorizontalHeaderLabels(["ID", "Стоянка", "Неисправность", "Приоритет", "Назначенный техник", "Статус"])
        self.requests_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.requests_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.requests_table)

    def init_chat_tab(self):
        layout = QHBoxLayout(self.tab_chat)
        layout.setContentsMargins(8, 8, 8, 8)

        splitter = QSplitter(Qt.Orientation.Horizontal, self)

        # Левая колонка: Каналы и контакты
        left_panel = QFrame(self)
        left_panel.setStyleSheet("background-color: #0B1120; border: 1px solid #1E293B; border-radius: 8px;")
        l_layout = QVBoxLayout(left_panel)
        l_layout.addWidget(QLabel("КАНАЛЫ И СОТРУДНИКИ", self))

        self.rooms_list = QListWidget(self)
        self.rooms_list.itemClicked.connect(self.on_room_clicked)
        l_layout.addWidget(self.rooms_list)

        splitter.addWidget(left_panel)

        # Правая колонка: Сообщения и блок голосовой связи
        right_panel = QFrame(self)
        r_layout = QVBoxLayout(right_panel)

        # Панель вызова (Walkie-Talkie Bar)
        call_bar = QFrame(self)
        call_bar.setStyleSheet("background-color: #0F172A; border: 1px solid #1E293B; border-radius: 6px; padding: 6px;")
        cb_layout = QHBoxLayout(call_bar)

        self.chat_title_label = QLabel("Общий канал смены", self)
        self.chat_title_label.setStyleSheet("font-size: 14px; font-weight: bold; color: #38BDF8;")
        cb_layout.addWidget(self.chat_title_label)

        cb_layout.addStretch()

        self.call_status_label = QLabel("Связь свободна", self)
        self.call_status_label.setStyleSheet("color: #94A3B8; font-size: 12px;")
        cb_layout.addWidget(self.call_status_label)

        self.call_btn = QPushButton("📞 Голосовой вызов", self)
        self.call_btn.setProperty("class", "success-btn")
        self.call_btn.clicked.connect(self.toggle_voice_call)
        cb_layout.addWidget(self.call_btn)

        self.mute_btn = QPushButton("🎤 Микрофон вкл", self)
        self.mute_btn.setEnabled(False)
        self.mute_btn.clicked.connect(self.toggle_mute)
        cb_layout.addWidget(self.mute_btn)

        r_layout.addWidget(call_bar)

        # Окно сообщений
        self.chat_history_edit = QTextEdit(self)
        self.chat_history_edit.setReadOnly(True)
        r_layout.addWidget(self.chat_history_edit)

        # Поле ввода сообщения
        msg_input_layout = QHBoxLayout()
        self.chat_input = QLineEdit(self)
        self.chat_input.setPlaceholderText("Напишите сообщение в канал...")
        self.chat_input.returnPressed.connect(self.send_chat_message)
        msg_input_layout.addWidget(self.chat_input)

        btn_send = QPushButton("Отправить", self)
        btn_send.setProperty("class", "primary-btn")
        btn_send.clicked.connect(self.send_chat_message)
        msg_input_layout.addWidget(btn_send)

        r_layout.addLayout(msg_input_layout)

        splitter.addWidget(right_panel)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 3)

        layout.addWidget(splitter)

    # ---------- ЛОГИКА СОБЫТИЙ ----------
    def update_clock(self):
        now = QDateTime.currentDateTimeUtc()
        self.clock_label.setText(now.toString("hh:mm:ss") + " UTC")

    def update_call_timer(self):
        if self.call_start_time > 0:
            elapsed = int(time.time() - self.call_start_time)
            mins, secs = divmod(elapsed, 60)
            self.call_status_label.setText(f"Идёт вызов ({mins:02d}:{secs:02d})")

    def on_connection_change(self, is_connected: bool):
        if is_connected:
            self.vps_indicator.setText("● VPS: Подключен")
            self.vps_indicator.setStyleSheet("color: #10B981; font-weight: bold; font-size: 12px;")
            self.statusBar().showMessage("Связь с VPS установлена.")
        else:
            self.vps_indicator.setText("● VPS: Офлайн")
            self.vps_indicator.setStyleSheet("color: #EF4444; font-weight: bold; font-size: 12px;")
            self.statusBar().showMessage("Связь с VPS потеряна. Повторная попытка...")

    def on_state_received(self, state: Dict[str, Any]):
        # Обновление карты
        self.map_view.update_state(state)

        # Обновление таблицы бортов
        aircraft_list = state.get("aircraft", [])
        self.flights_table.setRowCount(len(aircraft_list))
        for row, ac in enumerate(aircraft_list):
            self.flights_table.setItem(row, 0, QTableWidgetItem(ac.get("flight", "-")))
            self.flights_table.setItem(row, 1, QTableWidgetItem(f"Стоянка {ac.get('stand', '-')}"))
            self.flights_table.setItem(row, 2, QTableWidgetItem(ac.get("model", "A320")))
            self.flights_table.setItem(row, 3, QTableWidgetItem(ac.get("status", "Обслуживание")))

            # Прогресс норматива
            pbar = QProgressBar()
            pbar.setValue(min(100, int(ac.get("turnaround_progress", 40))))
            self.flights_table.setCellWidget(row, 4, pbar)

            btn_depart = QPushButton("Вылет")
            aid = ac.get("id")
            btn_depart.clicked.connect(lambda _, a=aid: self.depart_aircraft(a))
            self.flights_table.setCellWidget(row, 5, btn_depart)

        # Обновление таблицы техников
        techs_list = state.get("techs", [])
        self.techs_table.setRowCount(len(techs_list))
        for row, t in enumerate(techs_list):
            self.techs_table.setItem(row, 0, QTableWidgetItem(t.get("name", "Техник")))
            self.techs_table.setItem(row, 1, QTableWidgetItem(t.get("qual", "Планер")))
            self.techs_table.setItem(row, 2, QTableWidgetItem(", ".join(t.get("types", []))))
            self.techs_table.setItem(row, 3, QTableWidgetItem(t.get("status", "Свободен")))
            self.techs_table.setItem(row, 4, QTableWidgetItem("Да" if t.get("on_shift", True) else "Нет"))

            btn_call_tech = QPushButton("Позвонить")
            tid = t.get("id")
            tname = t.get("name", "Техник")
            btn_call_tech.clicked.connect(lambda _, i=tid, n=tname: self.start_direct_call(i, n))
            self.techs_table.setCellWidget(row, 5, btn_call_tech)

        # Обновление таблицы заявок
        requests_list = list(state.get("requests", {}).values())
        self.requests_table.setRowCount(len(requests_list))
        for row, r in enumerate(requests_list):
            self.requests_table.setItem(row, 0, QTableWidgetItem(f"#{r.get('id', '-') }"))
            self.requests_table.setItem(row, 1, QTableWidgetItem(f"Стоянка {r.get('stand', '-') }"))
            self.requests_table.setItem(row, 2, QTableWidgetItem(r.get("description", "-")))
            self.requests_table.setItem(row, 3, QTableWidgetItem(r.get("priority", "normal")))
            self.requests_table.setItem(row, 4, QTableWidgetItem(r.get("tech_name", "Авто-подбор")))
            self.requests_table.setItem(row, 5, QTableWidgetItem(r.get("status", "pending")))

    def on_airport_changed(self, index: int):
        try:
            airport_data = self.client.get_airport()
            self.map_view.load_airport(airport_data)
        except Exception as e:
            self.statusBar().showMessage(f"Ошибка загрузки карты аэропорта: {e}")

    def spawn_aircraft(self):
        try:
            self.client.session.post(f"{self.client.base_url}/api/aircraft/spawn")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось добавить борт: {e}")

    def depart_aircraft(self, aid: int):
        try:
            self.client.session.post(f"{self.client.base_url}/api/aircraft/{aid}/depart")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось отправить борт: {e}")

    def open_new_request_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Новая заявка на обслуживание")
        dialog.setFixedWidth(400)
        d_layout = QFormLayout(dialog)

        stand_input = QLineEdit(dialog)
        stand_input.setPlaceholderText("Например: 14 или 22")
        desc_input = QLineEdit(dialog)
        desc_input.setPlaceholderText("Описание проблемы")
        qual_combo = QComboBox(dialog)
        qual_combo.addItems(["auto (Автоподбор)", "Планер", "Двигатель", "Авионика"])
        prio_combo = QComboBox(dialog)
        prio_combo.addItems(["normal (Обычный)", "emergency (ЧС / Норматив 15м)"])

        d_layout.addRow("Стоянка:", stand_input)
        d_layout.addRow("Проблема:", desc_input)
        d_layout.addRow("Квалификация:", qual_combo)
        d_layout.addRow("Приоритет:", prio_combo)

        btn_box = QHBoxLayout()
        btn_ok = QPushButton("Создать заявку", dialog)
        btn_ok.setProperty("class", "primary-btn")
        btn_ok.clicked.connect(dialog.accept)
        btn_box.addWidget(btn_ok)
        d_layout.addRow(btn_box)

        if dialog.exec():
            stand = stand_input.text().strip()
            desc = desc_input.text().strip()
            qual = qual_combo.currentText().split()[0]
            prio = prio_combo.currentText().split()[0]
            if stand and desc:
                try:
                    self.client.create_request(stand, desc, qual, prio)
                    self.statusBar().showMessage(f"Заявка на стоянку {stand} создана.")
                except Exception as e:
                    QMessageBox.warning(self, "Ошибка", f"Не удалось создать заявку: {e}")

    # ---------- ЧАТ И ГОЛОСОВАЯ СВЯЗЬ ----------
    def refresh_contacts(self):
        try:
            self.rooms_list.clear()
            # Общий канал
            item_shift = QListWidgetItem("📢 Общий канал смены")
            item_shift.setData(Qt.ItemDataRole.UserRole, ("shift", None, "Общий канал смены"))
            self.rooms_list.addItem(item_shift)

            contacts = self.client.get_contacts()
            for c in contacts:
                cid = c.get("id")
                cname = c.get("name", "Инженер")
                on_shift = c.get("on_shift", True)
                status_dot = "🟢" if on_shift else "⚪"
                item = QListWidgetItem(f"{status_dot} {cname}")
                item.setData(Qt.ItemDataRole.UserRole, ("direct", cid, cname))
                self.rooms_list.addItem(item)
        except Exception:
            pass

    def on_room_clicked(self, item: QListWidgetItem):
        kind, peer_id, name = item.data(Qt.ItemDataRole.UserRole)
        self.active_room_kind = kind
        self.active_peer_id = peer_id
        self.active_peer_name = name
        self.chat_title_label.setText(name)
        self.chat_input.setPlaceholderText(f"Напишите в {name}...")
        self.load_chat_history()

    def load_chat_history(self):
        try:
            history = self.client.get_chat_history(self.active_room_kind, self.active_peer_id)
            self.chat_history_edit.clear()
            for m in history:
                sender = m.get("sender_name", "Сотрудник")
                body = m.get("body", "")
                time_str = m.get("created_at", "")[:19].replace("T", " ")
                self.chat_history_edit.append(f"<b style='color:#38BDF8;'>{sender}</b> <span style='color:#64748B; font-size:10px;'>[{time_str}]</span><br>{body}<br>")
        except Exception as e:
            self.chat_history_edit.setPlainText(f"Не удалось загрузить историю: {e}")

    def send_chat_message(self):
        text = self.chat_input.text().strip()
        if not text:
            return
        try:
            ok = self.client.send_chat_message(text, self.active_room_kind, self.active_peer_id)
            if ok:
                now_str = QDateTime.currentDateTime().toString("hh:mm:ss")
                my_name = self.current_user.get("name", "Диспетчер") if self.current_user else "Диспетчер"
                self.chat_history_edit.append(f"<b style='color:#10B981;'>{my_name}</b> <span style='color:#64748B; font-size:10px;'>[{now_str}]</span><br>{text}<br>")
                self.chat_input.clear()
        except Exception as e:
            QMessageBox.warning(self, "Ошибка чата", f"Не удалось отправить сообщение: {e}")

    def on_chat_message_received(self, msg: Dict[str, Any]):
        sender = msg.get("sender_name", "Собеседник")
        body = msg.get("body", "")
        time_str = QDateTime.currentDateTime().toString("hh:mm:ss")
        self.chat_history_edit.append(f"<b style='color:#F59E0B;'>{sender}</b> <span style='color:#64748B; font-size:10px;'>[{time_str}]</span><br>{body}<br>")

    # ---------- ГОЛОСОВЫЕ ВЫЗОВЫ (Walkie-Talkie) ----------
    def start_direct_call(self, peer_id: int, peer_name: str):
        self.tabs.setCurrentWidget(self.tab_chat)
        self.active_room_kind = "direct"
        self.active_peer_id = peer_id
        self.active_peer_name = peer_name
        self.chat_title_label.setText(peer_name)
        self.toggle_voice_call()

    def toggle_voice_call(self):
        if self.voice.is_in_call:
            # Завершение вызова
            self.voice.end_call()
            if self.active_peer_id:
                self.client.send_call_signal({"kind": "hangup"}, self.active_peer_id)
            self.call_btn.setText("📞 Голосовой вызов")
            self.call_btn.setProperty("class", "success-btn")
            self.call_status_label.setText("Связь свободна")
            self.mute_btn.setEnabled(False)
            self.call_timer.stop()
        else:
            # Начало вызова
            if not self.active_peer_id:
                QMessageBox.information(self, "Голосовая связь", "Выберите конкретного сотрудника из списка для голосового вызова.")
                return
            call_id = f"call_{min(self.client.user.get('id', 1), self.active_peer_id)}_{max(self.client.user.get('id', 1), self.active_peer_id)}"
            self.active_call_id = call_id
            self.voice.set_base_url(self.client.base_url)
            self.voice.start_call(call_id, self.client.token or "")

            # Отправка сигнала звонка собеседнику
            self.client.send_call_signal({"kind": "ring", "call_id": call_id}, self.active_peer_id)

            self.call_btn.setText("📴 Завершить звонок")
            self.call_btn.setProperty("class", "danger-btn")
            self.call_status_label.setText("Соединение с VPS...")
            self.mute_btn.setEnabled(True)
            self.call_start_time = time.time()
            self.call_timer.start(1000)

    def toggle_mute(self):
        is_muted = self.voice.toggle_mute()
        if is_muted:
            self.mute_btn.setText("🔇 Микрофон ВЫКЛ")
            self.mute_btn.setProperty("class", "danger-btn")
        else:
            self.mute_btn.setText("🎤 Микрофон вкл")
            self.mute_btn.setProperty("class", "")

    def on_voice_call_connected(self, call_id: str):
        self.call_status_label.setText("● В эфире (Связь активна)")
        self.call_status_label.setStyleSheet("color: #10B981; font-weight: bold;")

    def on_voice_call_ended(self):
        self.call_btn.setText("📞 Голосовой вызов")
        self.call_btn.setProperty("class", "success-btn")
        self.call_status_label.setText("Связь свободна")
        self.call_status_label.setStyleSheet("color: #94A3B8;")
        self.mute_btn.setEnabled(False)
        self.call_timer.stop()
        self.call_start_time = 0.0

    def on_call_signal(self, sig: Dict[str, Any]):
        kind = sig.get("kind")
        from_name = sig.get("from_name", "Сотрудник")
        from_id = sig.get("from_user_id")
        call_id = sig.get("call_id")

        if kind == "ring":
            ret = QMessageBox.question(self, "Входящий вызов", f"Входящий голосовой вызов от {from_name}.\nПринять вызов?", QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if ret == QMessageBox.StandardButton.Yes and from_id and call_id:
                self.active_peer_id = from_id
                self.active_peer_name = from_name
                self.voice.set_base_url(self.client.base_url)
                self.voice.start_call(call_id, self.client.token or "")
                self.call_btn.setText("📴 Завершить звонок")
                self.call_btn.setProperty("class", "danger-btn")
                self.mute_btn.setEnabled(True)
                self.call_start_time = time.time()
                self.call_timer.start(1000)
            elif from_id:
                self.client.send_call_signal({"kind": "decline"}, from_id)
        elif kind == "hangup" or kind == "decline":
            self.voice.end_call()
            self.on_voice_call_ended()

    # ---------- ДИАЛОГ НАСТРОЙКИ СЕРВЕРА ----------
    def open_settings_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Подключение к VPS серверу RampPulse")
        dialog.setFixedWidth(440)
        d_layout = QFormLayout(dialog)

        server_input = QLineEdit(self.client.base_url, dialog)
        email_input = QLineEdit("dispatcher@oto.ru", dialog)
        pass_input = QLineEdit("Dispatcher2026!", dialog)
        pass_input.setEchoMode(QLineEdit.EchoMode.Password)

        d_layout.addRow("Адрес VPS (URL):", server_input)
        d_layout.addRow("Email диспетчера:", email_input)
        d_layout.addRow("Пароль:", pass_input)

        hint = QLabel("Подсказка: для теста на локальной машине используйте http://127.0.0.1:8000\nДля вашего сервера укажите http://IP_ВАШЕГО_VPS или домен.", dialog)
        hint.setStyleSheet("color: #64748B; font-size: 11px;")
        d_layout.addRow(hint)

        btn_box = QHBoxLayout()
        btn_connect = QPushButton("Войти и подключиться", dialog)
        btn_connect.setProperty("class", "primary-btn")
        btn_connect.clicked.connect(dialog.accept)
        btn_box.addWidget(btn_connect)
        d_layout.addRow(btn_box)

        if dialog.exec():
            vps_url = server_input.text().strip()
            email = email_input.text().strip()
            password = pass_input.text().strip()
            self.connect_to_server(vps_url, email, password)

    def connect_to_server(self, url: str, email: str, password: str):
        self.client.set_base_url(url)
        self.voice.set_base_url(url)
        try:
            login_data = self.client.login(email, password)
            self.current_user = login_data.get("user")
            self.user_label.setText(f"👤 {self.current_user.get('name', 'Диспетчер')}")

            # Загрузка карты
            airport_data = self.client.get_airport()
            self.map_view.load_airport(airport_data)

            # Запуск WebSocket
            self.client.start_websocket()

            # Загрузка каналов
            self.refresh_contacts()
            self.load_chat_history()

            self.statusBar().showMessage(f"Успешное подключение к {url}")
        except Exception as e:
            QMessageBox.critical(self, "Ошибка подключения", f"Не удалось подключиться к серверу:\n{e}")
